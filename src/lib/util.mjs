import { AGENT_ID_REGISTRY, NATIVE_BNB, ZERO } from './const.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

export const lc = (a) => String(a ?? '').toLowerCase();

export function requireAddress(value, name = 'address') {
  if (!isAddress(value)) throw new Error(`${name} 必須是 0x 開頭的 20-byte 地址`);
  return lc(value);
}

export const strip0x = (hex) => String(hex || '').replace(/^0x/i, '');

export const word = (hex) => strip0x(hex).padStart(64, '0');

export const encAddr = (a) => word(lc(a));

export const encUint = (n) => word(BigInt(n).toString(16));

export const wa = (a) => encAddr(a);

export const w = (n) => encUint(n);

export function padTopicAddress(a) {
  return '0x' + encAddr(a);
}

export function wordAddr(wordBig) {
  return '0x' + BigInt(wordBig).toString(16).padStart(40, '0');
}

export function firstWord(hex) {
  const h = strip0x(hex);
  if (h.length < 64) return 0n;
  return BigInt('0x' + h.slice(0, 64));
}

export function words(hex) {
  const h = strip0x(hex);
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt('0x' + (h.slice(i, i + 64) || '0')));
  return out;
}

export function decodeString(hex) {
  try {
    const h = strip0x(hex);
    if (h.length < 128) {
      const raw = Buffer.from(h.replace(/00+$/, ''), 'hex').toString('utf8').replace(/\0/g, '').trim();
      return raw || null;
    }
    const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
    const len = Number(BigInt('0x' + h.slice(off, off + 64)));
    if (!Number.isFinite(len) || len < 0 || len > 256) return null;
    return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
  } catch {
    return null;
  }
}

export function parseUnits(value, decimals, key = 'amount') {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${key} 必須是正小數，例如 "0.05"`);
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`${key} 小數位超過 ${decimals}`);
  const raw = BigInt(int + frac.padEnd(decimals, '0'));
  if (raw === 0n) throw new Error(`${key} 必須大於 0`);
  return raw;
}

export function formatUnits(raw, decimals = 18) {
  const n = BigInt(raw);
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${int}.${frac}` : int);
}

export function weiToBnb(wei) {
  return Number(BigInt(wei || 0n)) / 1e18;
}

export function bnbToWei(bnb) {
  return parseUnits(String(bnb), 18, 'bnb');
}

export function isNative(addr) {
  return lc(addr).startsWith('0xeeee') || lc(addr) === ZERO;
}

export function sameAddr(a, b) {
  return lc(a) === lc(b);
}

export function isInfra(addr, extra = []) {
  const x = lc(addr);
  return x === AGENT_ID_REGISTRY || x === NATIVE_BNB || extra.some((e) => lc(e) === x);
}

export function todayKey(timeZone = 'Asia/Taipei') {
  return new Date().toLocaleDateString('sv-SE', { timeZone });
}

/** config timeZone 當天，YYYYMMDD。 */
export function todayCompact(timeZone = 'Asia/Taipei') {
  return todayKey(timeZone).replaceAll('-', '');
}

export function formatTs(timeZone = 'Asia/Taipei') {
  return new Date().toLocaleString('zh-TW', { hour12: false, timeZone });
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function safeJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

export function codeFingerprint(code) {
  const c = String(code || '').toLowerCase().replace(/^0x/, '');
  return `${c.length}:${c.slice(0, 120)}${c.slice(-120)}`;
}

export function parsePct(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  if (n > 1 && n <= 100) return n;
  if (n >= 0 && n <= 1) return n * 100;
  return null;
}

export function shortAddr(a) {
  const s = String(a || '');
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** 有上限的並行 map，用來把 getBlock / getCode 打到多個 RPC。 */
export async function mapLimit(items, limit, fn) {
  const arr = [...items];
  const out = new Array(arr.length);
  let i = 0;
  const n = Math.max(1, Math.min(Number(limit) || 1, arr.length || 1));
  if (!arr.length) return out;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= arr.length) return;
      out[idx] = await fn(arr[idx], idx);
    }
  }));
  return out;
}
