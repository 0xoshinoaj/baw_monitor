import { INFRA, TOPIC_TRANSFER, ZERO } from '../lib/const.mjs';
import { lc, padTopicAddress } from '../lib/util.mjs';
import { bytecodeMentionsRegistry, holdsAgentIdBatch, resolveImpl } from '../chain/code.mjs';
import { countAgentHeat } from '../classify/heat.mjs';
import { DEFAULT_LAG_JUMP_BLOCKS, planBlockRange } from './scan-range.mjs';

const DEFAULT_WINDOW_MS = 900_000;
const DEFAULT_LOOKBACK = 60;
const DEFAULT_FAIL_COOLDOWN_MS = 30_000;

/** 跨輪累加 Transfer from 0 的不同收款地址。視窗過期就重算。 */
export function noteMintLogs(mints, logs, now, windowMs, onReset) {
  for (const L of logs || []) {
    const tok = lc(L.address);
    if (INFRA.has(tok)) continue;
    const to = lc('0x' + String(L.topics?.[2] || '').slice(-40));
    if (!to || to === ZERO) continue;
    let row = mints.get(tok);
    if (!row) {
      row = { at: now, tos: new Set() };
      mints.set(tok, row);
    } else if (now - row.at > windowMs) {
      row.at = now;
      row.tos = new Set();
      onReset?.(tok);
    }
    row.tos.add(to);
  }
}

/** 清掉累積窗已過期的 token 紀錄。 */
export function pruneMintRecords(mints, now, windowMs) {
  const dead = [];
  for (const [addr, row] of mints) {
    if (now - row.at > windowMs) {
      mints.delete(addr);
      dead.push(addr);
    }
  }
  return dead;
}

export function createMintEventsSource(cfg, rpc, log) {
  const opt = cfg.discovery.mintEvents;
  let lastAt = 0;
  let lastBlock = 0;
  let busy = false;
  let failUntil = 0;
  const mints = new Map();
  const checked = new Map();
  let pending = [];

  function takePending() {
    if (!pending.length) return [];
    const out = pending;
    pending = [];
    return out;
  }

  async function score(windowMs) {
    const min = opt.minMints || 8;
    const cands = [];
    for (const [addr, row] of mints) {
      const uniq = [...row.tos];
      if (uniq.length < min) continue;
      if (checked.has(addr) && uniq.length < checked.get(addr) * 2) continue;
      checked.set(addr, uniq.length);
      const map = await holdsAgentIdBatch(rpc, uniq.slice(0, 24));
      const heat = countAgentHeat(uniq, map);
      const code = await rpc.getCode(addr).catch(() => '0x');
      const full = await resolveImpl(rpc, addr, code);
      const exclusive = bytecodeMentionsRegistry(full) || heat.agentIdWallets / Math.max(1, uniq.length) >= 0.6;
      if (!exclusive) continue;
      cands.push({
        address: addr,
        source: 'mintEvents',
        firstSeenAt: Date.now(),
        extra: {
          isAgentIdExclusive: exclusive,
          heat: { ...heat, windowMs },
        },
      });
    }
    return cands;
  }

  async function runRound() {
    const windowMs = opt.windowMs || DEFAULT_WINDOW_MS;
    const lookback = opt.lookbackBlocks || DEFAULT_LOOKBACK;
    const head = await rpc.blockNumber();
    const plan = planBlockRange({
      cursor: lastBlock,
      head,
      lookback,
      lagJump: opt.lagJumpBlocks || DEFAULT_LAG_JUMP_BLOCKS,
      firstBlocks: 5,
    });
    if (plan.from > plan.to) return;
    if (plan.jumped) {
      log?.warn(`鑄造事件落後 ${plan.lag} 塊，跳到最新附近 ${plan.from}-${plan.to}`);
    }
    const filter = {
      fromBlock: '0x' + Math.max(0, plan.from).toString(16),
      toBlock: '0x' + plan.to.toString(16),
      topics: [TOPIC_TRANSFER, padTopicAddress(ZERO)],
    };
    let logs;
    try {
      logs = await (rpc.getMintLogs ? rpc.getMintLogs(filter) : rpc.getLogs(filter));
    } catch (e) {
      failUntil = Date.now() + (opt.failCooldownMs || DEFAULT_FAIL_COOLDOWN_MS);
      log?.warn(`鑄造事件 getLogs／收據失敗，本輪跳過、游標不推進：${e?.message || e}`);
      return;
    }
    lastBlock = plan.to;
    const now = Date.now();
    noteMintLogs(mints, logs, now, windowMs, (tok) => checked.delete(tok));
    for (const addr of pruneMintRecords(mints, now, windowMs)) checked.delete(addr);
    const maxTos = mints.size
      ? Math.max(...[...mints.values()].map((row) => row.tos.size))
      : 0;
    log?.info(`鑄造事件：本輪 ${logs.length} 筆，累積 ${mints.size} 個代幣，最大 ${maxTos} 個收款`);
    const cands = await score(windowMs);
    if (cands.length) {
      pending.push(...cands);
      log?.info(`鑄造事件：${cands.length} 個候選`);
    }
  }

  return {
    id: 'mintEvents',
    async poll() {
      if (!opt.enabled) return [];
      const out = takePending();
      if (busy) return out;
      if (Date.now() < failUntil) return out;
      const interval = opt.intervalMs || 0;
      if (interval > 0 && Date.now() - lastAt < interval) return out;
      lastAt = Date.now();
      busy = true;
      runRound()
        .catch((e) => {
          failUntil = Date.now() + (opt.failCooldownMs || DEFAULT_FAIL_COOLDOWN_MS);
          log?.warn('鑄造事件失敗：' + (e?.message || e));
        })
        .finally(() => { busy = false; });
      return out;
    },
  };
}
