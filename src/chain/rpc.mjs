import {
  CHAIN_ID_HEX, DEFAULT_LOGS_RPCS, DEFAULT_RECEIPT_RPCS, LOGS_RPC_PRIMARY_COUNT,
  MULTICALL3, RECEIPT_RPC_CONCURRENCY,
} from '../lib/const.mjs';
import { isAddress, mapLimit, sleep } from '../lib/util.mjs';
import { decAggregate3, encAggregate3 } from './abi.mjs';

const TIMEOUT_MS = 12_000;

export class CallReverted extends Error {
  constructor(message = 'execution reverted') {
    super(message);
    this.name = 'CallReverted';
  }
}

export class BadAddress extends Error {
  constructor(message = 'bad address') {
    super(message);
    this.name = 'BadAddress';
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || ''); }
}

function errText(err) {
  return String(err?.message || err || '');
}

function isExpectedCallFailure(err) {
  const msg = errText(err);
  return /execution reverted/i.test(msg)
    || /invalid params/i.test(msg)
    || /hex string has length/i.test(msg)
    || /invalid argument/i.test(msg)
    || /invalid address/i.test(msg);
}

function expectedError(err) {
  const msg = errText(err);
  if (/hex string has length|invalid address/i.test(msg)) return new BadAddress(msg);
  if (/invalid argument/i.test(msg) && /address/i.test(msg)) return new BadAddress(msg);
  return new CallReverted(msg);
}

function isNodeFailure(err) {
  const msg = errText(err);
  const name = String(err?.name || '');
  if (/HTTP 429|\b429\b/.test(msg)) return true;
  if (/limit exceeded|rate|too many|capacity|\blimit\b/i.test(msg)) return true;
  if (/timeout|ETIMEDOUT|aborted|AbortError/i.test(msg) || name === 'AbortError') return true;
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) return true;
  if (/HTTP 403/.test(msg)) return true;
  if (/HTTP 5\d\d/.test(msg)) return true;
  return false;
}

function cooldownMs(method, err) {
  const msg = errText(err);
  if (method === 'eth_getLogs') return 120_000;
  if (/429|limit|rate|too many|capacity/i.test(msg) || /HTTP 429/.test(msg)) return 60_000;
  return 20_000;
}

function makePool(urls) {
  return (urls || []).filter(Boolean).map((url) => ({ url, coolUntil: 0, fails: 0 }));
}

function parseBlockNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = parseInt(value, 16);
  return Number.isFinite(n) ? n : NaN;
}

function isMintTransferLog(log, topics) {
  const t0 = topics?.[0];
  const t1 = topics?.[1];
  if (t0 && String(log.topics?.[0] || '').toLowerCase() !== String(t0).toLowerCase()) return false;
  if (t1 && String(log.topics?.[1] || '').toLowerCase() !== String(t1).toLowerCase()) return false;
  return Boolean(log.topics?.[2]);
}

export function createRpc(urls, log) {
  const nodes = makePool(urls);
  const logsNodes = makePool(DEFAULT_LOGS_RPCS);
  const receiptsNodes = makePool(DEFAULT_RECEIPT_RPCS);
  const quietUntil = new Map();
  let cursor = 0;
  let logsCursor = 0;
  let receiptsCursor = 0;

  async function post(url, method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function pickNext(pool, next) {
    if (!pool.length) return null;
    return pool[next() % pool.length];
  }

  function cool(node, ms = 30_000) {
    node.fails++;
    node.coolUntil = Date.now() + ms;
  }

  function warnFail(node, method, err, quietMs, cooled) {
    const key = `${hostOf(node.url)}|${method}`;
    const now = Date.now();
    if ((quietUntil.get(key) || 0) > now) return;
    quietUntil.set(key, now + quietMs);
    const extra = cooled ? `，冷卻 ${Math.round(quietMs / 1000)}s` : '';
    log?.warn(`RPC ${method} 失敗 ${hostOf(node.url)}：${err.message}${extra}`);
  }

  async function rpcOn(pool, next, method, params, { tries = pool.length, cooldown = false } = {}) {
    let last = null;
    const n = Math.min(tries, pool.length);
    if (!pool.length || n <= 0) throw last || new Error(`RPC ${method} 全部節點失敗`);
    const start = next();
    let attempts = 0;
    for (let i = 0; i < pool.length && attempts < n; i++) {
      const node = pool[(start + i) % pool.length];
      if (cooldown && node.coolUntil > Date.now()) continue;
      attempts++;
      try {
        const r = await post(node.url, method, params);
        if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
        node.fails = 0;
        return r.result;
      } catch (e) {
        last = e;
        if (isExpectedCallFailure(e)) throw expectedError(e);
        if (!isNodeFailure(e)) continue;
        const ms = cooldownMs(method, e);
        if (cooldown) cool(node, ms);
        warnFail(node, method, e, ms, cooldown);
      }
    }
    throw last || new Error(`RPC ${method} 全部節點失敗`);
  }

  async function rpc(method, params, tries = nodes.length) {
    return rpcOn(nodes, () => cursor++, method, params, { tries, cooldown: false });
  }

  async function rpcBatch(calls) {
    const node = pickNext(nodes, () => cursor++);
    if (!node) throw new Error('RPC 無可用節點');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
      const res = await fetch(node.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json();
      const byId = new Map((Array.isArray(arr) ? arr : [arr]).map((x) => [x.id, x]));
      return calls.map((_, i) => {
        const x = byId.get(i + 1);
        if (!x || x.error) return undefined;
        return x.result;
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(to, data, extra = {}) {
    if (!isAddress(to)) return null;
    return rpc('eth_call', [{ to, data, ...extra }, extra.block || 'latest']);
  }

  async function multicall(calls, block = 'latest') {
    const hex = await rpc('eth_call', [{ to: MULTICALL3, data: encAggregate3(calls) }, block]);
    return decAggregate3(hex).map((r) => (r.success ? r.data : null));
  }

  async function blockNumber() {
    const hex = await rpc('eth_blockNumber', []);
    const n = parseInt(hex, 16);
    if (!Number.isFinite(n) || n <= 0) throw new Error('無效 blockNumber');
    return n;
  }

  async function getBlocks(from, to, full = true) {
    const nums = [];
    for (let n = from; n <= to; n++) nums.push(n);
    if (!nums.length) return [];
    const conc = Math.min(Math.max(nodes.length, 4), 12);
    return mapLimit(nums, conc, (n) => getBlock(n, full).catch(() => null));
  }

  async function getCode(addr, block = 'latest') {
    return (await rpc('eth_getCode', [addr, block])) || '0x';
  }

  async function getBalance(addr, block = 'latest') {
    return BigInt((await rpc('eth_getBalance', [addr, block])) || '0x0');
  }

  async function getBlockMintLogsFromReceipts(blockNum, topics) {
    const hex = '0x' + Number(blockNum).toString(16);
    try {
      const receipts = await rpcOn(
        receiptsNodes,
        () => receiptsCursor++,
        'eth_getBlockReceipts',
        [hex],
        { cooldown: true },
      );
      if (!Array.isArray(receipts)) return null;
      const out = [];
      for (const rc of receipts) {
        for (const L of rc.logs || []) {
          if (isMintTransferLog(L, topics)) out.push(L);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  async function getMintLogsFromReceipts(filter) {
    const from = parseBlockNum(filter?.fromBlock);
    const to = parseBlockNum(filter?.toBlock);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new Error('RPC eth_getBlockReceipts 區塊範圍無效');
    }
    log?.warn(`鑄造事件 getLogs 全失敗，改用區塊收據 ${from}-${to}`);
    const nums = [];
    for (let n = from; n <= to; n++) nums.push(n);
    const conc = Math.min(Math.max(1, RECEIPT_RPC_CONCURRENCY), receiptsNodes.length || 1);
    const chunks = await mapLimit(nums, conc, (n) => getBlockMintLogsFromReceipts(n, filter?.topics));
    const out = [];
    let got = 0;
    for (const logs of chunks) {
      if (!logs) continue;
      got++;
      out.push(...logs);
    }
    if (got === 0) throw new Error('RPC eth_getBlockReceipts 全部失敗');
    return out;
  }

  async function getMintLogs(filter) {
    const primaryCount = Math.min(LOGS_RPC_PRIMARY_COUNT, logsNodes.length);
    const primaries = logsNodes.slice(0, primaryCount);
    const backups = logsNodes.slice(primaryCount);
    try {
      const result = await rpcOn(primaries, () => logsCursor++, 'eth_getLogs', [filter], { cooldown: true });
      return Array.isArray(result) ? result : [];
    } catch (err) {
      if (backups.length) {
        try {
          const result = await rpcOn(backups, () => 0, 'eth_getLogs', [filter], { cooldown: true });
          return Array.isArray(result) ? result : [];
        } catch {
          // 無地址 getLogs 後備也失敗，改獨立收據池
        }
      }
      return getMintLogsFromReceipts(filter);
    }
  }

  async function getLogs(filter) {
    if (!filter?.address) return getMintLogs(filter);
    return (await rpc('eth_getLogs', [filter])) || [];
  }

  async function getBlock(num, full = true) {
    return rpc('eth_getBlockByNumber', ['0x' + Number(num).toString(16), full]);
  }

  async function waitHealthy() {
    for (let i = 0; i < 5; i++) {
      try {
        const id = await rpc('eth_chainId', []);
        if (id === CHAIN_ID_HEX) return;
        log?.warn(`節點 chainId=${id}，預期 ${CHAIN_ID_HEX}`);
      } catch (e) {
        log?.warn(`RPC 尚未就緒：${e.message}`);
      }
      await sleep(1000);
    }
  }

  return {
    rpc, rpcBatch, call, multicall, blockNumber, getCode, getBalance,
    getLogs, getMintLogs, getBlock, getBlocks, waitHealthy, nodes, logsNodes, receiptsNodes,
  };
}
