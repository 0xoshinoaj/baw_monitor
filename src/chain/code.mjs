import {
  AGENT_ID_REGISTRY, AGENT_ID_REGISTRY_BARE, EIP1967_BEACON, EIP1967_IMPL,
  INFRA, SEL,
} from '../lib/const.mjs';
import { encAddr, firstWord, isAddress, lc, wordAddr } from '../lib/util.mjs';

const implCache = new Map();
const agentCache = new Map();

export async function resolveImpl(rpc, addr, code) {
  const c = lc(addr);
  if (implCache.has(c)) return implCache.get(c);
  let hex = String(code || '').toLowerCase();
  if (hex.length < 4) hex = String(await rpc.getCode(c)).toLowerCase();
  const seen = new Set([c]);
  const add = async (a) => {
    const x = lc(a);
    if (!x.startsWith('0x') || x.length !== 42 || seen.has(x) || INFRA.has(x)) return;
    seen.add(x);
    const more = String(await rpc.getCode(x)).toLowerCase();
    if (more.length > 4) hex += more;
  };

  // EIP-1167 最小代理
  const m1167 = hex.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  if (m1167) await add('0x' + m1167[1]);

  try {
    const impl = await rpc.rpc('eth_getStorageAt', [c, EIP1967_IMPL, 'latest']);
    if (impl && BigInt(impl) !== 0n) await add(wordAddr(firstWord(impl)));
  } catch { /* ignore */ }
  try {
    const bc = await rpc.rpc('eth_getStorageAt', [c, EIP1967_BEACON, 'latest']);
    if (bc && BigInt(bc) !== 0n) {
      const r = await rpc.call(wordAddr(firstWord(bc)), SEL.implementation);
      if (r && BigInt(r) !== 0n) await add(wordAddr(firstWord(r)));
    }
  } catch { /* ignore */ }

  const embedded = [...hex.matchAll(/63([0-9a-f]{40})/g)].slice(0, 4);
  for (const m of embedded) {
    if (m[1].length !== 40) continue;
    const a = '0x' + m[1];
    if (!isAddress(a)) continue;
    if (hex.includes(AGENT_ID_REGISTRY_BARE)) break;
    try {
      const r = await rpc.call(a, SEL.implementation);
      if (r && r.length >= 66 && BigInt(r.slice(0, 66)) !== 0n) await add(wordAddr(firstWord(r)));
      else await add(a);
    } catch { await add(a); }
  }

  implCache.set(c, hex);
  return hex;
}

export function bytecodeMentionsRegistry(code) {
  return String(code || '').toLowerCase().includes(AGENT_ID_REGISTRY_BARE);
}

export async function holdsAgentId(rpc, addr) {
  const a = lc(addr);
  if (agentCache.has(a)) return agentCache.get(a);
  try {
    const r = await rpc.call(AGENT_ID_REGISTRY, SEL.balanceOf + encAddr(a));
    const ok = !!(r && r.length >= 66 && firstWord(r) > 0n);
    agentCache.set(a, ok);
    return ok;
  } catch {
    return false;
  }
}

export async function holdsAgentIdBatch(rpc, addrs) {
  const unknown = [...new Set(addrs.map(lc))].filter((a) => !agentCache.has(a));
  if (unknown.length) {
    try {
      const res = await rpc.rpcBatch(unknown.map((a) => ({
        method: 'eth_call',
        params: [{ to: AGENT_ID_REGISTRY, data: SEL.balanceOf + encAddr(a) }, 'latest'],
      })));
      unknown.forEach((a, i) => {
        const r = res[i];
        agentCache.set(a, !!(r && r.length >= 66 && firstWord(r) > 0n));
      });
    } catch {
      for (const a of unknown) agentCache.set(a, await holdsAgentId(rpc, a));
    }
  }
  const map = new Map();
  for (const a of addrs) map.set(lc(a), !!agentCache.get(lc(a)));
  return map;
}

/** 合約 bytecode 含登記合約，或抽樣參與者 ≥60% 持有 Agent ID。 */
export async function classifyAgentIdExclusive(rpc, addr, code, sampleAddrs = []) {
  const full = await resolveImpl(rpc, addr, code);
  if (bytecodeMentionsRegistry(full)) {
    return { exclusive: true, reason: 'bytecode', share: 1 };
  }
  const sample = [...new Set(sampleAddrs.map(lc))].filter((a) => a && a.length === 42).slice(0, 16);
  if (sample.length < 5) return { exclusive: false, reason: 'unknown', share: 0 };
  const map = await holdsAgentIdBatch(rpc, sample);
  let n = 0;
  for (const a of sample) if (map.get(a)) n++;
  const share = n / sample.length;
  if (share >= 0.6) return { exclusive: true, reason: 'holderSample', share };
  return { exclusive: false, reason: 'holderSample', share };
}

export async function readMeta(rpc, addr) {
  const [sym, name, dec, owner, token] = await Promise.all([
    rpc.call(addr, SEL.symbol).catch(() => null),
    rpc.call(addr, SEL.name).catch(() => null),
    rpc.call(addr, SEL.decimals).catch(() => null),
    rpc.call(addr, SEL.owner).catch(() => null),
    rpc.call(addr, SEL.token).catch(() => null),
  ]);
  const { decodeString } = await import('../lib/util.mjs');
  let tokenAddress = lc(addr);
  if (token && token.length >= 66 && firstWord(token) > 0n) tokenAddress = wordAddr(firstWord(token));
  return {
    symbol: decodeString(sym) || '',
    name: decodeString(name) || '',
    decimals: dec && dec.length >= 66 ? Number(firstWord(dec)) : null,
    deployer: owner && owner.length >= 66 && firstWord(owner) > 0n ? wordAddr(firstWord(owner)) : '',
    tokenAddress,
  };
}

export function looksUpgradeable(code, storageHits = []) {
  if (storageHits.some(Boolean)) return true;
  const c = String(code || '').toLowerCase();
  return c.includes('5c60da1b') || c.includes(EIP1967_IMPL.slice(2, 18));
}
