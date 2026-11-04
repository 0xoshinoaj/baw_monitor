import { AGENT_ID_REGISTRY, SEL, USDT, WBNB } from '../lib/const.mjs';
import { encAddr, firstWord, lc } from '../lib/util.mjs';

const ADDR_WORD = /^0{24}[0-9a-f]{40}$/;

export function extractWords(data) {
  return String(data || '').slice(10).match(/.{64}/g) || [];
}

export function replaceDeadline(data, nowSec = Math.floor(Date.now() / 1000) + 600) {
  const words = extractWords(data);
  if (!words.length) return data;
  let changed = false;
  const next = words.map((w) => {
    const n = BigInt('0x' + w);
    if (n > 1_700_000_000n && n < 2_200_000_000n) {
      changed = true;
      return n.toString(16).padStart(64, '0');
    }
    return w;
  });
  if (!changed) return data;
  const latest = BigInt(nowSec).toString(16).padStart(64, '0');
  return data.slice(0, 10) + next.map((w) => {
    const n = BigInt('0x' + w);
    return (n > 1_700_000_000n && n < 2_200_000_000n) ? latest : w;
  }).join('');
}

/**
 * 把 calldata 裡他人地址換成自己或零地址；含 Agent ID tokenId 則換成自己的。
 * 替換後 eth_call 失敗 → 丟 REPLAY_FOREIGN_ADDR。
 */
export async function rewriteReplayCalldata(rpc, { data, valueWei, wallet, to, agentId }) {
  let words = extractWords(data);
  const me = wallet.slice(2).toLowerCase();
  const skip = new Set([me, to.slice(2).toLowerCase(), USDT.slice(2), WBNB.slice(2)]);

  if (agentId) {
    for (let i = 0; i < words.length; i++) {
      const x = words[i].toLowerCase();
      if (/^0{24}/.test(x) || BigInt('0x' + x) < 2n ** 128n || x === agentId) continue;
      try {
        const o = await rpc.call(AGENT_ID_REGISTRY, SEL.ownerOf + x);
        if (o && firstWord(o) > 0n && o.slice(26, 66).toLowerCase() !== me) {
          words[i] = agentId;
        }
      } catch { /* 不是 tokenId */ }
    }
  }

  const foreign = words
    .map((x, i) => [x.toLowerCase(), i])
    .filter(([x]) => ADDR_WORD.test(x) && x.slice(24, 32) !== '00000000' && !skip.has(x.slice(24)))
    .map(([, i]) => i);

  let next = data.slice(0, 10) + words.join('');
  if (!foreign.length) return { data: next, foreignUnresolved: false };

  for (const repl of [me.padStart(64, '0'), '0'.repeat(64)]) {
    const d2 = data.slice(0, 10) + words.map((x, i) => (foreign.includes(i) ? repl : x)).join('');
    try {
      await rpc.rpc('eth_call', [{
        from: wallet,
        to,
        data: d2,
        value: '0x' + BigInt(valueWei || 0).toString(16),
      }, 'latest']);
      return { data: d2, foreignUnresolved: false };
    } catch { /* 試下一個替換 */ }
  }
  return { data: next, foreignUnresolved: true };
}

export function scaleValue(data0, data1, valueWei) {
  try {
    const a = BigInt('0x' + data0.slice(10, 74));
    const b = BigInt('0x' + data1.slice(10, 74));
    if (a >= 1n && a <= 100n && b >= 1n && b < a) return (BigInt(valueWei) * b) / a;
  } catch { /* ignore */ }
  return BigInt(valueWei || 0);
}

export async function fitShares(rpc, { data, valueWei, from, to }) {
  const words = extractWords(data);
  if (!words.length) return { data, valueWei: BigInt(valueWei || 0) };
  let n0 = BigInt('0x' + words[0]);
  if (n0 < 1n || n0 > 100n) return { data, valueWei: BigInt(valueWei || 0) };
  const orig = n0;
  for (const n of [n0, ...[5n, 3n, 2n, 1n].filter((x) => x < n0)]) {
    const d2 = data.slice(0, 10) + n.toString(16).padStart(64, '0') + words.slice(1).join('');
    const vv = (BigInt(valueWei || 0) * n) / orig;
    try {
      await rpc.rpc('eth_call', [{ from, to, data: d2, value: '0x' + vv.toString(16) }, 'latest']);
      return { data: d2, valueWei: vv };
    } catch { /* 再降份數 */ }
  }
  return { data, valueWei: BigInt(valueWei || 0) };
}

export async function learnReplay(rpc, contract) {
  const head = await rpc.blockNumber();
  const from = Math.max(0, head - 80);
  const logs = await rpc.getLogs({
    address: contract,
    fromBlock: '0x' + from.toString(16),
    toBlock: '0x' + head.toString(16),
  }).catch(() => []);
  void logs;
  // 從最近成功交易還原 calldata：取最近區塊裡 to=contract 且成功的 input
  for (let b = head; b >= from; b--) {
    const blk = await rpc.getBlock(b, true).catch(() => null);
    if (!blk?.transactions) continue;
    for (const tx of blk.transactions) {
      if (lc(tx.to) !== lc(contract)) continue;
      if (!tx.input || tx.input.length < 10) continue;
      if (tx.from && tx.input) {
        return { data: tx.input, valueWei: BigInt(tx.value || '0x0'), from: lc(tx.from) };
      }
    }
  }
  return null;
}
