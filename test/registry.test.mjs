import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistry,
  emptyProject,
  formatProjectRef,
  MAINTAIN_BATCH_SIZE,
  MAINTAIN_OLD_COOLDOWN_MS,
  MAINTAIN_OLD_RESERVE,
  pickMaintainBatch,
  projectLabel,
  shortContract,
  shouldLogBlockReason,
} from '../src/project/registry.mjs';
import { formatBlockedLines, formatBlockedTitle, formatDiscoveredTitle } from '../src/notify/events.mjs';
import { decide, strategyBlockReason } from '../src/policy/rules.mjs';

const AWM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FOO = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NONAME = '0x813d000000000000000000000000000000007953';

function memStore(data = { items: {}, seq: { day: '', n: 0 } }) {
  return { data, mark() {}, save() {} };
}

const cfg = {
  execution: { free: 'notify', paid: 'auto' },
  thresholds: { progressPct: 60, agentIdWallets: 100, requirePerWalletCap: true },
  budget: { maxUsdPerProject: 20, maxUsdPerDay: 200, keepBnb: 0.006 },
};

const base = {
  address: AWM,
  kind: 'free',
  paid: false,
  isAgentIdExclusive: true,
  progress: { pct: 70, reliable: true },
  heat: { agentIdWallets: 120 },
  risk: { flags: [], drain: false, serial: false, blacklist: false },
  mint: { perWalletCap: 1 },
  walletState: {},
  deployer: '0xdef',
};

test('編號格式與當日遞增、同地址不重發', () => {
  const reg = createRegistry(memStore(), { day: '20261101' });
  const a = reg.ingest({ address: AWM, extra: { symbol: 'AWM' } });
  assert.equal(formatProjectRef(a.project), '20261101#00001-AWM');
  assert.equal(a.project.ref, '20261101#00001-AWM');
  assert.equal(a.discovered, true);

  const b = reg.ingest({ address: FOO, extra: { symbol: 'FOO' } });
  assert.equal(formatProjectRef(b.project), '20261101#00002-FOO');
  assert.equal(b.discovered, true);

  const again = reg.ingest({ address: AWM.toUpperCase(), extra: { symbol: 'AWM' } });
  assert.equal(formatProjectRef(again.project), '20261101#00001-AWM');
  assert.equal(again.discovered, false);
  assert.equal(again.created, false);
});

test('無名用短地址 0x+前4+...+後4', () => {
  assert.equal(shortContract(NONAME), '0x813d...7953');
  assert.equal(projectLabel({ address: NONAME }), '0x813d...7953');
  const reg = createRegistry(memStore(), { day: '20261101' });
  const { project } = reg.ingest({ address: NONAME });
  assert.equal(formatProjectRef(project), '20261101#00001-0x813d...7953');
});

test('名稱去掉 #／換行，太長截斷', () => {
  assert.equal(projectLabel({ symbol: 'Rush#Rush\nRush' }), 'RushRushRush');
  assert.equal(projectLabel({ symbol: 'X'.repeat(40) }).length, 32);
});

test('舊項目沒編號，第一次再看到補發當天序號', () => {
  const store = memStore();
  store.data.items[AWM] = emptyProject(AWM);
  store.data.items[AWM].symbol = 'OLD';
  const reg = createRegistry(store, { day: '20261101' });
  const { project, discovered } = reg.ingest({ address: AWM, extra: { symbol: 'OLD' } });
  assert.equal(formatProjectRef(project), '20261101#00001-OLD');
  assert.equal(discovered, false);
});

test('重複 discovered 不重複編號／不重複事件', () => {
  const reg = createRegistry(memStore(), { day: '20261101' });
  const first = reg.ingest({ address: AWM, extra: { symbol: 'AWM' } });
  const second = reg.ingest({ address: AWM, extra: { symbol: 'AWM' } });
  assert.equal(first.discovered, true);
  assert.equal(second.discovered, false);
  assert.equal(formatProjectRef(first.project), formatProjectRef(second.project));
  assert.equal(formatDiscoveredTitle(first.project), '發現候選 20261101#00001-AWM');
});

test('擋住文案標題精簡、內文短句加叉', () => {
  const project = { ...base, symbol: 'RushRushRush', ref: '20261101#00003-RushRushRush', progress: { pct: 12, reliable: true }, heat: { agentIdWallets: 8 } };
  const d = decide(project, cfg, {});
  const reason = strategyBlockReason(d);
  assert.match(reason, /鑄造進度 12% 未達 60%/);
  assert.match(reason, /Agent ID 錢包數 8 未達 100/);
  const title = formatBlockedTitle(project, reason);
  assert.equal(title, '阻擋 20261101#00003-RushRushRush');
  const lines = formatBlockedLines(project, cfg, {}, { decision: d });
  assert.equal(lines[0], '鑄造進度 12% / 60% ❌');
  assert.equal(lines[1], '.ai錢包數 8/100 ❌');
  assert.equal(lines[2], '[0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa](https://bscscan.com/address/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)');
  assert.equal(lines[3], '本日已花費 0/200 U');
});

test('付費沒上限與同一原因不重複 log', () => {
  const project = {
    ...base,
    symbol: 'CAP',
    ref: '20261101#00004-CAP',
    kind: 'bnb',
    paid: true,
    mint: { perWalletCap: null },
    lastBlockReason: '',
  };
  const d = decide(project, cfg, {});
  assert.equal(strategyBlockReason(d), '付費合約沒有每錢包／每筆上限');
  const title = formatBlockedTitle(project, strategyBlockReason(d));
  assert.equal(title, '阻擋 20261101#00004-CAP');
  assert.equal(shouldLogBlockReason(project, strategyBlockReason(d)), true);
  assert.equal(shouldLogBlockReason(project, strategyBlockReason(d)), false);
  assert.equal(shouldLogBlockReason(project, '鑄造進度 20% 未達 60%'), true);
});

function addr(n) {
  return `0x${String(n).padStart(40, '0')}`;
}

function item(n, extra = {}) {
  const now = extra.now ?? 1_000_000;
  return {
    address: extra.address || addr(n),
    sources: extra.sources || [],
    firstSeenAt: extra.firstSeenAt ?? now,
    updatedAt: extra.updatedAt ?? now,
    lastCheckedAt: extra.lastCheckedAt ?? 0,
    heat: extra.heat || { agentIdWallets: 0, txs: 0, windowMs: 0, updatedAt: 0 },
    status: extra.status || 'watching',
  };
}

test('pickMaintainBatch：新熱度／剛 ingest 優先，舊項降頻並保留 2–3 個', () => {
  const now = 10_000_000;
  const freshHeat = item(1, {
    now,
    sources: ['heat'],
    firstSeenAt: now - 5_000,
    updatedAt: now - 5_000,
    heat: { updatedAt: now - 4_000 },
  });
  const freshMint = item(2, {
    now,
    sources: ['mintEvents'],
    firstSeenAt: now - 8_000,
    updatedAt: now - 3_000,
  });
  const freshNew = item(3, {
    now,
    sources: ['newContracts'],
    firstSeenAt: now - 2_000,
    updatedAt: now - 2_000,
  });
  const hotter = item(4, {
    now,
    sources: ['heat'],
    firstSeenAt: now - 6_000,
    updatedAt: now - 6_000,
    heat: { updatedAt: now - 1_000 },
  });
  const oldRecent = item(5, {
    now,
    sources: ['heat'],
    firstSeenAt: now - 3_600_000,
    updatedAt: now - 3_600_000,
    lastCheckedAt: now - 30_000,
    heat: { updatedAt: now - 3_600_000 },
  });
  const oldReady1 = item(6, {
    now,
    sources: ['memeRush'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastCheckedAt: now - MAINTAIN_OLD_COOLDOWN_MS - 5_000,
  });
  const oldReady2 = item(7, {
    now,
    sources: ['heat'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastCheckedAt: now - MAINTAIN_OLD_COOLDOWN_MS - 20_000,
    heat: { updatedAt: now - 86_400_000 },
  });
  const oldReady3 = item(8, {
    now,
    sources: ['memeRush'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastCheckedAt: now - MAINTAIN_OLD_COOLDOWN_MS - 1_000,
  });
  const oldNever = item(9, {
    now,
    sources: ['heat'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastCheckedAt: 0,
    heat: { updatedAt: now - 86_400_000 },
  });

  const batch = pickMaintainBatch([
    oldRecent, oldReady3, oldNever, oldReady1, freshMint, hotter, oldReady2, freshHeat, freshNew,
  ], { now });

  const addrs = batch.map((p) => p.address);
  assert.deepEqual(addrs, [
    hotter.address, freshHeat.address, freshNew.address, freshMint.address,
    oldNever.address, oldReady2.address, oldReady1.address, oldReady3.address,
  ]);
  assert.ok(!addrs.includes(oldRecent.address));
});

test('pickMaintainBatch：每輪約 12 筆且舊項占 2–3 個', () => {
  const now = 20_000_000;
  const fresh = Array.from({ length: 20 }, (_, i) => item(i + 1, {
    now,
    sources: ['heat'],
    firstSeenAt: now - 1_000 - i,
    updatedAt: now - 1_000 - i,
    heat: { updatedAt: now - i },
  }));
  const olds = Array.from({ length: 10 }, (_, i) => item(100 + i, {
    now,
    sources: ['memeRush'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastCheckedAt: now - MAINTAIN_OLD_COOLDOWN_MS - 10_000 - i * 1_000,
  }));
  const cooling = Array.from({ length: 5 }, (_, i) => item(200 + i, {
    now,
    sources: ['memeRush'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastCheckedAt: now - 20_000,
  }));

  const batch = pickMaintainBatch(fresh.concat(olds, cooling), { now });
  assert.equal(batch.length, MAINTAIN_BATCH_SIZE);
  const oldAddrs = new Set(olds.map((p) => p.address));
  const coolAddrs = new Set(cooling.map((p) => p.address));
  const oldPicked = batch.filter((p) => oldAddrs.has(p.address));
  assert.equal(oldPicked.length, MAINTAIN_OLD_RESERVE);
  assert.ok(oldPicked.every((p) => !coolAddrs.has(p.address)));
  assert.ok(batch.every((p) => !coolAddrs.has(p.address)));
});

test('pickMaintainBatch：檢查後又被熱度 ingest 會插隊', () => {
  const now = 30_000_000;
  const reheated = item(1, {
    now,
    sources: ['heat'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 2_000,
    lastCheckedAt: now - 20_000,
    heat: { updatedAt: now - 1_000 },
  });
  const coolingOld = item(2, {
    now,
    sources: ['memeRush'],
    firstSeenAt: now - 86_400_000,
    updatedAt: now - 86_400_000,
    lastCheckedAt: now - 20_000,
  });
  const batch = pickMaintainBatch([coolingOld, reheated], { now });
  assert.deepEqual(batch.map((p) => p.address), [reheated.address]);
});

test('emptyProject 帶 lastCheckedAt，ingest 不改它', () => {
  const p = emptyProject(AWM, 'heat');
  assert.equal(p.lastCheckedAt, 0);
  const reg = createRegistry(memStore(), { day: '20261101' });
  const { project } = reg.ingest({ address: AWM, extra: { symbol: 'AWM' } });
  assert.equal(project.lastCheckedAt, 0);
  project.lastCheckedAt = 123;
  const again = reg.ingest({ address: AWM, extra: { heat: { agentIdWallets: 9 } } });
  assert.equal(again.project.lastCheckedAt, 123);
  assert.ok(again.project.heat.updatedAt > 0);
});
