import { mapLimit } from '../lib/util.mjs';
import { DEFAULT_LAG_JUMP_BLOCKS, formatScanLag, planBlockRange } from './scan-range.mjs';
import { createNewContractsSource } from './new-contracts.mjs';
import { createHeatSource } from './heat.mjs';

async function fetchBlocks(rpc, from, to) {
  if (from > to) return [];
  if (rpc.getBlocks) return rpc.getBlocks(from, to, true);
  return mapLimit(
    Array.from({ length: to - from + 1 }, (_, i) => from + i),
    8,
    (b) => rpc.getBlock(b, true).catch(() => null),
  );
}

/** 新合約與熱度共用一次抓塊，避免同一批 eth_getBlockByNumber(..., true) 打兩遍。 */
export function createChainScanSource(cfg, rpc, session, log) {
  const nc = createNewContractsSource(cfg, rpc);
  const heat = createHeatSource(cfg, rpc, log);
  let lastAt = 0;
  let lastHeatFlush = 0;

  return {
    id: 'chainScan',
    async poll() {
      const ncOn = nc.enabled;
      const heatOn = heat.enabled;
      if (!ncOn && !heatOn) return [];
      const interval = Math.min(
        ncOn ? nc.intervalMs : Infinity,
        heatOn ? heat.intervalMs : Infinity,
      );
      if (Date.now() - lastAt < interval) return [];
      lastAt = Date.now();

      const head = await rpc.blockNumber();
      const lookback = Math.max(
        ncOn ? nc.lookbackBlocks : 0,
        heatOn ? heat.lookbackBlocks : 0,
      );
      const lagJump = Math.min(
        ncOn ? nc.lagJumpBlocks : Infinity,
        heatOn ? heat.lagJumpBlocks : Infinity,
      );
      const plan = planBlockRange({
        cursor: session.data.scanCursor,
        head,
        lookback: lookback || 64,
        lagJump: Number.isFinite(lagJump) ? lagJump : DEFAULT_LAG_JUMP_BLOCKS,
        firstBlocks: heatOn ? 24 : 16,
      });
      if (plan.jumped) {
        if (ncOn) {
          log?.warn(`新合約掃描落後 ${plan.lag} 塊（約 ${Math.round(plan.lag * 0.45)} 秒），跳到最新附近 ${plan.from}-${plan.to}（略過 ${plan.skipped} 塊）`);
        }
        if (heatOn) {
          log?.warn(`熱度掃描落後 ${plan.lag} 塊，跳到最新附近 ${plan.from}-${plan.to}`);
        }
      }

      const blocks = plan.from <= plan.to ? await fetchBlocks(rpc, plan.from, plan.to) : [];
      const out = [];
      if (ncOn) out.push(...await nc.process(blocks));
      if (heatOn) heat.ingest(blocks);

      session.data.scanCursor = plan.to > 0 ? plan.to : head;
      session.mark();
      if (ncOn) {
        const headNow = await rpc.blockNumber().catch(() => head);
        const lag = formatScanLag({
          from: Math.min(plan.from, plan.to) || plan.to || head,
          to: session.data.scanCursor,
          head: headNow,
        });
        log?.info(`新合約掃描：${out.filter((c) => c.source === 'newContracts').length} 個候選（${lag.text}）`);
      }

      if (heatOn && Date.now() - lastHeatFlush >= heat.intervalMs) {
        lastHeatFlush = Date.now();
        out.push(...await heat.flush());
      }
      return out;
    },
  };
}
