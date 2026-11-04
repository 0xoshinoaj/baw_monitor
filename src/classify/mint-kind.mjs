import { BAD_SELECTORS, FREE_MINT_CANDIDATES, SEL, USDT } from '../lib/const.mjs';
import { firstWord, lc } from '../lib/util.mjs';
import { bytecodeMentionsRegistry } from '../chain/code.mjs';

export function isPaidKind(kind) {
  return kind === 'bnb' || kind === 'usdt' || kind === 'nft' || kind === 'recv' || kind === 'bonding' || kind === 'replay';
}

export function kindFromHints({ bonding, valueWei, payToken, replay }) {
  if (bonding) return 'bonding';
  if (replay) return 'replay';
  const v = BigInt(valueWei || 0);
  if (payToken && lc(payToken) === USDT) return 'usdt';
  if (v > 0n) return 'bnb';
  return 'free';
}

export function selectorAllowed(data) {
  const sel = String(data || '').slice(0, 10).toLowerCase();
  return sel.length === 10 && !BAD_SELECTORS.has(sel);
}

export function freeCandidatesInCode(code) {
  const c = String(code || '').toLowerCase();
  return FREE_MINT_CANDIDATES.filter((x) => c.includes(x.data.slice(2, 10)));
}

export async function probeFreeMint(rpc, from, to, code) {
  const cands = freeCandidatesInCode(code);
  for (const cand of cands) {
    if (!selectorAllowed(cand.data)) continue;
    try {
      await rpc.rpc('eth_call', [{ from, to, data: cand.data, value: '0x0' }, 'latest']);
      return { kind: 'free', name: cand.name, data: cand.data, valueWei: 0n };
    } catch { /* 下一個 */ }
  }
  return null;
}

export async function detectPerWalletCap(rpc, addr, code) {
  const c = String(code || '').toLowerCase();
  const sels = ['e2c79281', '5c975abb', '8da5cb5b', '18160ddd'];
  for (const s of ['6d540b29', '2b83fc40', 'd5abeb01', '32cb6b0c', '8f4b0ba8', '1f7b6d32']) {
    if (!c.includes(s)) continue;
    try {
      const r = await rpc.call(addr, '0x' + s);
      if (r && r.length >= 66) {
        const n = Number(firstWord(r));
        if (n >= 1 && n <= 1000) return n;
      }
    } catch { /* ignore */ }
  }
  void sels;
  return null;
}

export function classifyFromCode(code, { bonding = false } = {}) {
  if (bonding) return { kind: 'bonding', paid: true };
  const c = String(code || '').toLowerCase();
  const gated = bytecodeMentionsRegistry(c);
  const free = freeCandidatesInCode(c);
  if (free.length && gated) return { kind: 'free', paid: false, gated: true };
  if (c.includes(SEL.buyByBudget.slice(2)) || c.includes(SEL.buy.slice(2))) return { kind: 'bonding', paid: true };
  return { kind: 'unknown', paid: false, gated };
}
