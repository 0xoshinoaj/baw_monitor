import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHeatSummary,
  formatScanLag,
  planBlockRange,
} from '../src/discovery/scan-range.mjs';
import { logHeatCandidates } from '../src/discovery/heat.mjs';
import { createDiscovery } from '../src/discovery/index.mjs';
import {
  createMintEventsSource,
  noteMintLogs,
  pruneMintRecords,
} from '../src/discovery/mint-events.mjs';
import { AGENT_ID_REGISTRY_BARE, ZERO } from '../src/lib/const.mjs';
import { mapLimit, padTopicAddress } from '../src/lib/util.mjs';
import { formatProjectRef } from '../src/project/registry.mjs';

test('首次掃描只回看 firstBlocks', () => {
  const p = planBlockRange({ cursor: 0, head: 1000, lookback: 64, firstBlocks: 16 });
  assert.equal(p.from, 984);
  assert.equal(p.to, 1000);
  assert.equal(p.jumped, false);
  assert.equal(p.skipped, 0);
});

test('落後未超門檻就從 cursor 接著掃、每輪最多 lookback', () => {
  const p = planBlockRange({ cursor: 1000, head: 2021, lookback: 64 });
  assert.equal(p.from, 1001);
  assert.equal(p.to, 1064);
  assert.equal(p.lag, 1021);
  assert.equal(p.jumped, false);
  assert.equal(p.skipped, 0);
});

test('預設 lagJump 1600：剛好不跳、超過才跳到最新附近', () => {
  const keep = planBlockRange({ cursor: 1000, head: 2600, lookback: 64 });
  assert.equal(keep.lag, 1600);
  assert.equal(keep.jumped, false);
  assert.equal(keep.from, 1001);
  assert.equal(keep.to, 1064);
  assert.equal(keep.skipped, 0);

  const jumped = planBlockRange({ cursor: 1000, head: 2601, lookback: 64 });
  assert.equal(jumped.lag, 1601);
  assert.equal(jumped.jumped, true);
  assert.equal(jumped.from, 2537);
  assert.equal(jumped.to, 2601);
  assert.equal(jumped.skipped, 1536);
});

test('已追上則 from > to', () => {
  const p = planBlockRange({ cursor: 1000, head: 1000, lookback: 64 });
  assert.equal(p.from, 1001);
  assert.equal(p.to, 1000);
  assert.equal(p.lag, 0);
  assert.equal(p.jumped, false);
});

test('掃描 log 含鏈頭與落後秒數', () => {
  const r = formatScanLag({ from: 131045357, to: 131045421, head: 131045892, blockMs: 450 });
  assert.equal(r.lag, 471);
  assert.equal(r.sec, 212);
  assert.match(r.text, /掃到區塊 131045357-131045421/);
  assert.match(r.text, /鏈頭 131045892/);
  assert.match(r.text, /落後 471 塊（約 212 秒）/);
});

test('熱度摘要含看到／達標／通過篩選', () => {
  const line = formatHeatSummary({
    seen: 80,
    reached: 3,
    passed: 2,
    windowMs: 180000,
    minWallets: 8,
  });
  assert.equal(line, '熱度掃描：看到 80 個合約，達標 3，通過篩選 2（window=180000ms minWallets=8）');
});

test('熱度候選一行一個且帶項目編號', () => {
  const lines = [];
  const log = { info: (m) => lines.push(m) };
  const projects = [
    { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ref: '20261101#00002-FOO', symbol: 'FOO' },
    { address: '0x813d000000000000000000000000000000007953', ref: '20261101#00003-0x813d...7953' },
  ];
  logHeatCandidates(log, projects);
  assert.equal(lines[0], '熱度掃描候選 2 個：');
  assert.equal(lines[1], '  20261101#00002-FOO  0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(lines[2], '  20261101#00003-0x813d...7953  0x813d000000000000000000000000000000007953');
  assert.equal(formatProjectRef(projects[0]), '20261101#00002-FOO');
  assert.ok(!lines.some((l) => l === '熱度掃描：2 個候選'));
});

test('新合約與熱度共用同一批區塊，不重複抓塊', async () => {
  const blockCalls = [];
  const rpc = {
    blockNumber: async () => 100,
    getBlocks: async (from, to) => {
      const out = [];
      for (let n = from; n <= to; n++) {
        blockCalls.push(n);
        out.push({ number: '0x' + n.toString(16), transactions: [] });
      }
      return out;
    },
    getBlock: async () => { throw new Error('不應再各自 getBlock'); },
    getCode: async () => '0x',
    rpc: async () => null,
    getMintLogs: async () => [],
    getLogs: async () => [],
  };
  const session = { data: { scanCursor: 0 }, mark() {} };
  const cfg = {
    forceMint: [],
    discovery: {
      memeRush: { enabled: false },
      newContracts: { enabled: true, intervalMs: 0, lookbackBlocks: 8, lagJumpBlocks: 400 },
      heat: { enabled: true, intervalMs: 0, lookbackBlocks: 8, windowMs: 180000, minWallets: 8 },
      mintEvents: { enabled: false },
    },
  };
  const logs = [];
  const discovery = createDiscovery(cfg, rpc, session, {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  });
  await discovery.pollAll();
  assert.ok(blockCalls.length > 0);
  assert.equal(blockCalls.length, new Set(blockCalls).size);
  assert.ok(logs.some((l) => /新合約掃描/.test(l)));
  assert.ok(logs.some((l) => /熱度掃描/.test(l)));
});

test('mapLimit 維持順序且限制並行', async () => {
  let inflight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4], 2, async (n) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 15));
    inflight--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40]);
  assert.ok(peak <= 2);
});

function waitUntil(fn, timeout = 800) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await fn()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - t0 > timeout) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function mintCfg(extra = {}) {
  return {
    enabled: true,
    intervalMs: 0,
    lookbackBlocks: 60,
    windowMs: 900_000,
    minMints: 8,
    lagJumpBlocks: 400,
    ...extra,
  };
}

test('鑄造事件跨輪累積 15 分鐘，過期紀錄清掉', () => {
  const tok = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const mk = (to) => ({
    address: tok,
    topics: ['0xddf', padTopicAddress(ZERO), padTopicAddress(to)],
  });
  const mints = new Map();
  const windowMs = 900_000;
  noteMintLogs(mints, [mk('0x1111111111111111111111111111111111111111'), mk('0x2222222222222222222222222222222222222222')], 1_000, windowMs);
  noteMintLogs(mints, [mk('0x3333333333333333333333333333333333333333')], 1_000 + 100_000, windowMs);
  assert.equal(mints.get(tok).tos.size, 3);
  noteMintLogs(mints, [mk('0x4444444444444444444444444444444444444444')], 1_000 + 900_001, windowMs);
  assert.equal(mints.get(tok).tos.size, 1);
  assert.ok(mints.get(tok).tos.has('0x4444444444444444444444444444444444444444'));
  pruneMintRecords(mints, 1_000 + 900_001 + 900_001, windowMs);
  assert.equal(mints.size, 0);
});

test('鑄造事件忙就跳過、不卡住 pollAll，每輪最多約 60 塊', async () => {
  let release;
  let logCalls = 0;
  let finished = 0;
  let head = 2000;
  const filters = [];
  const rpc = {
    blockNumber: async () => head,
    getMintLogs: (filter) => {
      logCalls++;
      filters.push(filter);
      return new Promise((r) => {
        release = () => { finished++; r([]); };
      });
    },
    getLogs: async () => { throw new Error('不應打主池 getLogs'); },
    getBlocks: async () => [],
    getCode: async () => '0x',
  };
  const cfg = {
    forceMint: [],
    discovery: {
      memeRush: { enabled: false },
      newContracts: { enabled: false },
      heat: { enabled: false },
      mintEvents: mintCfg(),
    },
  };
  const d = createDiscovery(cfg, rpc, { data: {}, mark() {} }, { info() {}, warn() {} });
  const t0 = Date.now();
  const first = d.pollAll();
  await waitUntil(() => logCalls === 1);
  assert.deepEqual(await first, []);
  assert.ok(Date.now() - t0 < 300);
  const t1 = Date.now();
  await d.pollAll();
  assert.ok(Date.now() - t1 < 200);
  assert.equal(logCalls, 1);
  release();
  await waitUntil(() => finished === 1);
  head = 2200;
  await waitUntil(async () => {
    if (logCalls >= 2) return true;
    await d.pollAll();
    return logCalls >= 2;
  });
  const from = parseInt(filters[1].fromBlock, 16);
  const to = parseInt(filters[1].toBlock, 16);
  assert.equal(from, 2001);
  assert.equal(to, 2060);
  assert.equal(to - from + 1, 60);
  release();
});

test('鑄造事件 getLogs 失敗不推進游標、冷卻期間不重試', async () => {
  let calls = 0;
  let fail = true;
  const filters = [];
  const rpc = {
    blockNumber: async () => 2000,
    getMintLogs: async (filter) => {
      calls++;
      filters.push(filter);
      if (fail) throw new Error('RPC eth_getLogs 全部節點失敗');
      return [];
    },
    getLogs: async () => { throw new Error('不應打主池 getLogs'); },
  };
  const warns = [];
  const src = createMintEventsSource(
    { discovery: { mintEvents: mintCfg({ failCooldownMs: 40 }) } },
    rpc,
    { info() {}, warn: (m) => warns.push(m) },
  );
  await src.poll();
  await waitUntil(() => calls === 1 && warns.some((w) => /getLogs／收據失敗/.test(w) && /游標不推進/.test(w)));
  const t0 = Date.now();
  while (Date.now() - t0 < 20) {
    await src.poll();
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(calls, 1);
  fail = false;
  await waitUntil(async () => {
    if (calls >= 2) return true;
    await src.poll();
    return calls >= 2;
  });
  assert.equal(parseInt(filters[0].fromBlock, 16), parseInt(filters[1].fromBlock, 16));
  assert.equal(parseInt(filters[0].toBlock, 16), parseInt(filters[1].toBlock, 16));
});

test('鑄造事件跨輪湊滿 minMints 才出候選', async () => {
  const tok = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let round = 0;
  const logsOf = (n, start) => Array.from({ length: n }, (_, i) => {
    const x = (start + i).toString(16).padStart(40, '0');
    return { address: tok, topics: ['0xddf', padTopicAddress(ZERO), '0x' + x] };
  });
  const rpc = {
    blockNumber: async () => 100 + round * 10,
    getMintLogs: async () => {
      round++;
      return round === 1 ? logsOf(3, 1) : logsOf(5, 4);
    },
    getLogs: async () => { throw new Error('不應打主池 getLogs'); },
    getCode: async () => '0x' + AGENT_ID_REGISTRY_BARE,
    rpc: async () => '0x' + '0'.repeat(64),
    rpcBatch: async () => [],
  };
  const lines = [];
  const src = createMintEventsSource(
    { discovery: { mintEvents: mintCfg() } },
    rpc,
    { info: (m) => lines.push(m), warn() {} },
  );
  let cands = [];
  await waitUntil(async () => {
    if (cands.length) return true;
    cands = await src.poll();
    return cands.length === 1;
  });
  assert.equal(cands[0].address, tok);
  assert.equal(cands[0].source, 'mintEvents');
  assert.equal(cands[0].extra.heat.windowMs, 900_000);
  assert.equal(cands[0].extra.heat.wallets, 8);
  assert.ok(round >= 2);
  assert.ok(lines.some((l) => /鑄造事件：本輪 \d+ 筆，累積 \d+ 個代幣，最大 \d+ 個收款/.test(l)));
  assert.ok(lines.some((l) => l === '鑄造事件：1 個候選'));
});

test('鑄造事件掃到後推進游標，下一輪接著往後', async () => {
  const filters = [];
  let head = 2000;
  const rpc = {
    blockNumber: async () => head,
    getMintLogs: async (filter) => {
      filters.push(filter);
      return [];
    },
    getLogs: async () => { throw new Error('不應打主池 getLogs'); },
  };
  const lines = [];
  const src = createMintEventsSource(
    { discovery: { mintEvents: mintCfg() } },
    rpc,
    { info: (m) => lines.push(m), warn() {} },
  );
  await src.poll();
  await waitUntil(() => filters.length === 1 && lines.some((l) => /本輪 0 筆/.test(l)));
  head = 2100;
  await waitUntil(async () => {
    if (filters.length >= 2) return true;
    await src.poll();
    return filters.length >= 2;
  });
  assert.equal(parseInt(filters[0].toBlock, 16), 2000);
  assert.equal(parseInt(filters[1].fromBlock, 16), 2001);
});

