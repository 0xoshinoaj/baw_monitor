import { CREATE2_DEPLOYERS, INFRA } from '../lib/const.mjs';
import { DEFAULT_LAG_JUMP_BLOCKS } from './scan-range.mjs';
import { create2Address } from '../lib/keccak.mjs';
import { lc, mapLimit } from '../lib/util.mjs';
import { bytecodeMentionsRegistry, resolveImpl } from '../chain/code.mjs';

function createdAddresses(tx) {
  const out = [];
  if (!tx.to) {
    // 一般 CREATE：需要 receipt，這裡先略過，靠 input 裡的 CREATE2 與後續 code 掃描
  }
  const to = lc(tx.to || '');
  const inp = String(tx.input || '').toLowerCase();
  if (to === '0x4e59b44847b379578588920ca78fbf26c0b4956c' && inp.length > 70) {
    const salt = inp.slice(2, 66);
    const init = inp.slice(66);
    try { out.push(create2Address(to, salt, init)); } catch { /* ignore */ }
  }
  if (CREATE2_DEPLOYERS.includes(to) && inp.length > 2000) {
    // 其他工廠：從 receipt 才準，這裡標記稍後用 code 掃
  }
  return out;
}

export function createNewContractsSource(cfg, rpc) {
  const opt = cfg.discovery.newContracts;
  return {
    id: 'newContracts',
    enabled: !!opt.enabled,
    intervalMs: opt.intervalMs || 3000,
    lookbackBlocks: opt.lookbackBlocks || 64,
    lagJumpBlocks: opt.lagJumpBlocks || DEFAULT_LAG_JUMP_BLOCKS,
    async process(blocks) {
      const cands = [];
      const seen = new Set();
      const pending = [];
      const createTxs = [];
      for (const blk of blocks || []) {
        if (!blk?.transactions) continue;
        for (const tx of blk.transactions) {
          const addrs = createdAddresses(tx);
          if (!tx.to && tx.hash) createTxs.push(tx);
          for (const addr of addrs) {
            const a = lc(addr);
            if (seen.has(a) || INFRA.has(a)) continue;
            seen.add(a);
            pending.push({ addr: a, deployer: lc(tx.from || '') });
          }
        }
      }
      const receipts = await mapLimit(createTxs, 8, (tx) => rpc.rpc('eth_getTransactionReceipt', [tx.hash]).catch(() => null));
      for (let i = 0; i < createTxs.length; i++) {
        const rc = receipts[i];
        const a = lc(rc?.contractAddress || '');
        if (!a || seen.has(a) || INFRA.has(a)) continue;
        seen.add(a);
        pending.push({ addr: a, deployer: lc(createTxs[i].from || '') });
      }
      const filtered = await mapLimit(pending, 8, async ({ addr, deployer }) => {
        const code = await rpc.getCode(addr).catch(() => '0x');
        if (!code || code.length < 4) return null;
        const full = await resolveImpl(rpc, addr, code);
        if (!bytecodeMentionsRegistry(full) && !full.includes('9f92d0dd')) return null;
        return {
          address: addr,
          source: 'newContracts',
          firstSeenAt: Date.now(),
          extra: { isAgentIdExclusive: bytecodeMentionsRegistry(full), deployer },
        };
      });
      for (const row of filtered) if (row) cands.push(row);
      return cands;
    },
  };
}
