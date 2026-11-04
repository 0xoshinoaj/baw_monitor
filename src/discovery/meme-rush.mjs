import { execFile } from 'node:child_process';
import {
  AGENT_ID_TOKEN_VERSION, MEME_RUSH_URL, OPEN_FOUR_PROTOCOL,
} from '../lib/const.mjs';
import { lc, parsePct, safeJson } from '../lib/util.mjs';

const BODY = (rankType, limit) => ({
  chainId: '56',
  rankType,
  protocol: [OPEN_FOUR_PROTOCOL],
  tokenVersionFilter: { [String(OPEN_FOUR_PROTOCOL)]: [AGENT_ID_TOKEN_VERSION] },
  limit,
});

async function httpList(rankType, limit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(MEME_RUSH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'baw-monitor/1.0',
      },
      body: JSON.stringify(BODY(rankType, limit)),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function spawnCli(cli, rankType, limit) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, 'meme-rush', JSON.stringify(BODY(rankType, limit))], { timeout: 20_000 }, (err, stdout, stderr) => {
      const j = safeJson(stdout || stderr || '');
      if (!j) return reject(err || new Error(stderr || 'meme-rush CLI 無 JSON'));
      resolve(j);
    });
  });
}

function rowsOf(json) {
  return json?.data?.list || json?.data?.rows || json?.data || json?.list || [];
}

function stageOf(rankType, migrateStatus) {
  if (Number(migrateStatus) === 1 || rankType === 30) return 'dex';
  if (rankType === 20) return 'bonding';
  return 'bonding';
}

export function createMemeRushSource(cfg, log) {
  const opt = cfg.discovery.memeRush;
  let lastAt = 0;
  return {
    id: 'memeRush',
    async poll() {
      if (!opt.enabled) return [];
      if (Date.now() - lastAt < (opt.intervalMs || 15_000)) return [];
      lastAt = Date.now();
      const out = [];
      const ranks = opt.rankTypes || [10, 20];
      for (const rankType of ranks) {
        try {
          const json = opt.cli || cfg.official.memeRushCli
            ? await spawnCli(opt.cli || cfg.official.memeRushCli, rankType, opt.limit || 50)
            : await httpList(rankType, opt.limit || 50);
          const rows = Array.isArray(rowsOf(json)) ? rowsOf(json) : [];
          for (const row of rows) {
            const address = lc(row.contractAddress || row.tokenAddress || row.address || '');
            if (!address.startsWith('0x') || address.length !== 42) continue;
            const pct = parsePct(row.progress);
            out.push({
              address,
              source: 'memeRush',
              firstSeenAt: Date.now(),
              extra: {
                symbol: row.symbol || '',
                name: row.name || row.symbol || '',
                progress: pct,
                progressHow: 'listing',
                progressReliable: pct != null,
                stage: stageOf(rankType, row.migrateStatus),
                kind: rankType === 30 ? 'unknown' : 'bonding',
                paid: rankType !== 30,
                isAgentIdExclusive: true,
                listing: { rankType, protocol: row.protocol, tokenVersion: row.tokenVersion, holders: row.holders, netBuy: row.netBuy },
              },
            });
          }
          if (!rows.length) log?.info(`meme-rush rankType=${rankType} 目前沒有 AgentIdExclusive`);
        } catch (e) {
          log?.warn(`meme-rush rankType=${rankType}：${e.message}`);
        }
      }
      return out;
    },
  };
}
