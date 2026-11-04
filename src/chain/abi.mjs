import { SEL } from '../lib/const.mjs';
import { encAddr, encUint, firstWord, strip0x, wordAddr, words } from '../lib/util.mjs';

export function encCall(selector, addrsAndUints = []) {
  let data = selector.startsWith('0x') ? selector : '0x' + selector;
  for (const x of addrsAndUints) {
    if (typeof x === 'string' && x.startsWith('0x') && x.length === 42) data += encAddr(x);
    else data += encUint(x);
  }
  return data;
}

export function balanceOfData(owner) {
  return SEL.balanceOf + encAddr(owner);
}

export function allowanceData(owner, spender) {
  return SEL.allowance + encAddr(owner) + encAddr(spender);
}

export function approveData(spender, amount) {
  return SEL.approve + encAddr(spender) + encUint(amount);
}

/** 靜態參數 + 結尾一個空 bytes（Open Four proof = 0x）。 */
export function encWithEmptyBytes(selector, staticWords) {
  return selector + staticWords.join('') + encUint(32 * (staticWords.length + 1)) + encUint(0);
}

export function encAggregate3(calls) {
  const tuples = calls.map(({ to, data }) => {
    const d = strip0x(data);
    const padded = d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    return encAddr(to) + encUint(1) + encUint(96) + encUint(d.length / 2) + padded;
  });
  const offsets = [];
  let off = 32 * tuples.length;
  for (const t of tuples) { offsets.push(encUint(off)); off += t.length / 2; }
  return SEL.aggregate3 + encUint(32) + encUint(tuples.length) + offsets.join('') + tuples.join('');
}

export function decAggregate3(hex) {
  const h = strip0x(hex);
  const at = (byteOff) => Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64)));
  const arr = at(0);
  const n = at(arr);
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + at(base + 32 * i);
    const dataOff = t + at(t + 32);
    const len = at(dataOff);
    out.push({ success: at(t) === 1, data: '0x' + h.slice((dataOff + 32) * 2, (dataOff + 32 + len) * 2) });
  }
  return out;
}

export function decodeEstimate(hex) {
  const [curveQuote, totalFee, userPays, userReceives, tokenAmount, executionPrice] = words(hex);
  return { curveQuote, totalFee, userPays, userReceives, tokenAmount, executionPrice };
}

export { firstWord, wordAddr, words };
