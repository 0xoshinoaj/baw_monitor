/** 熱度只算「自己送交易」且持有 Agent ID 的錢包。 */

import { ZERO } from '../lib/const.mjs';
import { lc } from '../lib/util.mjs';

/** enrich 沿用熱度數字的時效：近 15 分鐘不必重打 getLogs。 */
export const HEAT_FRESH_MS = 15 * 60 * 1000;
/** 約 15 分鐘（BSC ~0.45s／塊）。 */
export const HEAT_LOOKBACK_BLOCKS = 2000;

export function countAgentHeat(senders, agentMap) {
  const uniq = [...new Set((senders || []).map((a) => String(a).toLowerCase()))];
  let agentIdWallets = 0;
  for (const a of uniq) if (agentMap.get(a)) agentIdWallets++;
  return { wallets: uniq.length, agentIdWallets, txs: senders?.length || 0 };
}

export function mergeHeat(prev, next, windowMs) {
  return {
    agentIdWallets: Math.max(prev?.agentIdWallets || 0, next.agentIdWallets || 0),
    txs: Math.max(prev?.txs || 0, next.txs || 0),
    windowMs: windowMs || next.windowMs || prev?.windowMs || 0,
    updatedAt: Date.now(),
  };
}

/** 已有足夠新的 heat 數字就沿用，不必每輪重打。 */
export function heatIsFresh(heat, now = Date.now(), freshMs = HEAT_FRESH_MS) {
  const at = Number(heat?.updatedAt || 0);
  return at > 0 && now - at < freshMs;
}

/** Transfer from 0 的收款地址（可重複，txs 用筆數）。 */
export function recipientsFromMintLogs(logs) {
  const tos = [];
  for (const L of logs || []) {
    const to = lc('0x' + String(L.topics?.[2] || '').slice(-40));
    if (!to || to.length !== 42 || to === ZERO) continue;
    tos.push(to);
  }
  return tos;
}
