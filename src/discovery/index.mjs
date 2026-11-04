import { createMemeRushSource } from './meme-rush.mjs';
import { createChainScanSource } from './chain-scan.mjs';
import { createMintEventsSource } from './mint-events.mjs';
import { lc } from '../lib/util.mjs';

export function createDiscovery(cfg, rpc, session, log) {
  const sources = [
    createMemeRushSource(cfg, log),
    createChainScanSource(cfg, rpc, session, log),
    createMintEventsSource(cfg, rpc, log),
  ];

  function forceCandidates() {
    return (cfg.forceMint || []).map((a) => ({
      address: lc(a),
      source: 'forceMint',
      firstSeenAt: Date.now(),
      extra: { isAgentIdExclusive: true, kind: 'unknown' },
    }));
  }

  async function pollAll() {
    const out = [...forceCandidates()];
    const results = await Promise.allSettled(sources.map((s) => s.poll()));
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) out.push(...r.value);
      if (r.status === 'rejected') log?.warn('發現來源失敗：' + r.reason?.message);
    }
    return out;
  }

  return { sources, pollAll };
}
