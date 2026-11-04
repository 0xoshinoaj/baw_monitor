import { BAD_SELECTORS, INFRA } from '../lib/const.mjs';
import { lc, mapLimit } from '../lib/util.mjs';
import { holdsAgentIdBatch } from '../chain/code.mjs';
import { bytecodeMentionsRegistry, resolveImpl } from '../chain/code.mjs';
import { countAgentHeat } from '../classify/heat.mjs';
import { DEFAULT_LAG_JUMP_BLOCKS, formatHeatSummary } from './scan-range.mjs';
import { formatProjectRef } from '../project/registry.mjs';

export function createHeatSource(cfg, rpc, log) {
  const opt = cfg.discovery.heat;
  const buckets = new Map();

  function note(to, from) {
    if (!to || INFRA.has(lc(to))) return;
    const a = lc(to);
    const b = buckets.get(a) || { senders: [], at: Date.now() };
    b.senders.push(lc(from));
    b.at = Date.now();
    buckets.set(a, b);
  }

  return {
    id: 'heat',
    enabled: !!opt.enabled,
    intervalMs: opt.intervalMs || 20_000,
    lookbackBlocks: opt.lookbackBlocks || 32,
    lagJumpBlocks: opt.lagJumpBlocks || DEFAULT_LAG_JUMP_BLOCKS,
    ingest(blocks) {
      for (const blk of blocks || []) {
        if (!blk?.transactions) continue;
        for (const tx of blk.transactions) {
          if (!tx.to || !tx.from) continue;
          const inp = String(tx.input || '');
          if (inp.length < 10 || BAD_SELECTORS.has(inp.slice(0, 10).toLowerCase())) continue;
          if (BigInt(tx.value || '0x0') > 10n ** 15n) continue; // 大於 0.001 BNB 多半不是免費鑄
          note(tx.to, tx.from);
        }
      }
    },
    async flush() {
      const windowMs = opt.windowMs || 180_000;
      const minW = opt.minWallets || 8;
      const now = Date.now();
      const cands = [];
      let reached = 0;
      const hot = [];
      for (const [addr, b] of buckets) {
        if (now - b.at > windowMs) { buckets.delete(addr); continue; }
        const recent = b.senders;
        const uniq = new Set(recent);
        if (uniq.size < minW) continue;
        reached++;
        hot.push({ addr, recent, uniq });
      }
      const scored = await mapLimit(hot, 6, async ({ addr, recent, uniq }) => {
        const map = await holdsAgentIdBatch(rpc, [...uniq]);
        const heat = countAgentHeat(recent, map);
        if (heat.agentIdWallets < Math.max(3, Math.ceil(minW * 0.5))) return null;
        const code = await rpc.getCode(addr).catch(() => '0x');
        const full = await resolveImpl(rpc, addr, code);
        const exclusive = bytecodeMentionsRegistry(full) || heat.agentIdWallets / Math.max(1, heat.wallets) >= 0.6;
        if (!exclusive) return null;
        return {
          address: addr,
          source: 'heat',
          firstSeenAt: Date.now(),
          extra: {
            isAgentIdExclusive: exclusive,
            heat: { ...heat, windowMs },
          },
        };
      });
      for (const row of scored) if (row) cands.push(row);
      log?.info(formatHeatSummary({
        seen: buckets.size,
        reached,
        passed: cands.length,
        windowMs,
        minWallets: minW,
      }));
      return cands;
    },
  };
}

/** 登錄後用項目編號完整列出熱度候選，一行一個，避免只寫「N 個」卻不知道是誰。逐址只進終端，避免灌爆 monitor.log。 */
export function logHeatCandidates(log, projects) {
  const rows = (projects || []).filter(Boolean);
  if (!rows.length) return;
  log?.info(`熱度掃描候選 ${rows.length} 個：`);
  for (const p of rows) {
    const ref = formatProjectRef(p) || p.address;
    log?.info(`  ${ref}  ${p.address}`, { file: false });
  }
}
