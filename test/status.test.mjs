import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/policy/rules.mjs';
import {
  markSeenClosed,
  resetWatchLogState,
  shouldLogWatchStatus,
  watchStatusSnapshot,
} from '../src/policy/status.mjs';

const cfg = {
  execution: { free: 'notify', paid: 'auto' },
  thresholds: { progressPct: 50, agentIdWallets: 100, requirePerWalletCap: true },
  budget: { maxUsdPerProject: 20, maxUsdPerDay: 200, keepBnb: 0.006 },
};

const base = {
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  symbol: 'Rush',
  ref: '20261101#00003-Rush',
  kind: 'free',
  paid: false,
  isAgentIdExclusive: true,
  progress: { pct: 48, reliable: true },
  heat: { agentIdWallets: 20 },
  risk: { flags: [], drain: false, serial: false, blacklist: false },
  mint: { perWalletCap: 1 },
  walletState: {},
  deployer: '0xdef',
};

test('進度未達：文案含編號、免費、現況／門檻、先追蹤', () => {
  const d = decide(base, cfg, {});
  const snap = watchStatusSnapshot(base, d, cfg);
  assert.match(snap.key, /progress_below/);
  assert.match(snap.line, /追蹤 20261101#00003-Rush 免費/);
  assert.match(snap.line, /進度 48%\/50%/);
  assert.match(snap.line, /錢包 20\/100/);
  assert.match(snap.line, /還沒到 50%/);
  assert.match(snap.line, /先追蹤/);
  assert.doesNotMatch(snap.line, /68%/);
  assert.doesNotMatch(snap.line, /130/);
});

test('讀不到進度：改看熱度與錢包門檻', () => {
  const project = { ...base, ref: '20261101#00004-Foo', symbol: 'Foo', progress: { pct: null, reliable: false }, heat: { agentIdWallets: 85 } };
  const d = decide(project, cfg, {});
  const snap = watchStatusSnapshot(project, d, cfg);
  assert.equal(snap.key, 'heat_below');
  assert.match(snap.line, /20261101#00004-Foo/);
  assert.match(snap.line, /進度讀不到改看熱度/);
  assert.match(snap.line, /錢包 85\/100/);
  assert.match(snap.line, /目前 85 個錢包在打，要 100 個以上才打，先追蹤/);
});

test('進度夠但錢包不夠：防灌進度', () => {
  const project = { ...base, ref: '20261101#00005-Bar', symbol: 'Bar', kind: 'bnb', paid: true, progress: { pct: 92, reliable: true }, heat: { agentIdWallets: 0 } };
  const d = decide(project, cfg, {});
  const snap = watchStatusSnapshot(project, d, cfg);
  assert.equal(snap.key, 'wallets_below');
  assert.match(snap.line, /付費/);
  assert.match(snap.line, /進度 92%\/50%/);
  assert.match(snap.line, /錢包 0\/100/);
  assert.match(snap.line, /防灌進度/);
});

test('免費達門檻：只通知不自動打', () => {
  const project = { ...base, progress: { pct: 70, reliable: true }, heat: { agentIdWallets: 120 } };
  const d = decide(project, cfg, {});
  const snap = watchStatusSnapshot(project, d, cfg);
  assert.equal(snap.key, 'notify_only');
  assert.match(snap.line, /達門檻（模式 notify），免費只通知不自動打/);
});

test('門檻數字跟 config，不寫死 68／130', () => {
  const custom = { ...cfg, thresholds: { ...cfg.thresholds, progressPct: 72, agentIdWallets: 88 } };
  const project = { ...base, progress: { pct: 40, reliable: true }, heat: { agentIdWallets: 10 } };
  const snap = watchStatusSnapshot(project, decide(project, custom, {}), custom);
  assert.match(snap.line, /進度 40%\/72%/);
  assert.match(snap.line, /錢包 10\/88/);
  assert.match(snap.line, /還沒到 72%/);
});

test('之前沒開、現在開了：加在同一行', () => {
  const project = { ...base, progress: { pct: 10, reliable: true } };
  const d = decide(project, cfg, {});
  const snap = watchStatusSnapshot(project, d, cfg, { justOpened: true });
  assert.match(snap.key, /^opened\|/);
  assert.match(snap.line, /之前還沒開，現在開了（免費），照規則檢查/);
  assert.match(snap.line, /進度 10%\/50%/);
});

test('自動打路徑不印追蹤狀態', () => {
  const project = { ...base, kind: 'bonding', paid: true, progress: { pct: 70, reliable: true }, heat: { agentIdWallets: 120 } };
  const snap = watchStatusSnapshot(project, decide(project, cfg, {}), cfg);
  assert.equal(snap.line, '');
});

test('同一原因要隔間隔才再印；原因變了立刻印', () => {
  resetWatchLogState();
  const addr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const t0 = 1_000_000;
  assert.equal(shouldLogWatchStatus(addr, 'progress_below', t0, 90_000), true);
  assert.equal(shouldLogWatchStatus(addr, 'progress_below', t0 + 1_000, 90_000), false);
  assert.equal(shouldLogWatchStatus(addr, 'wallets_below', t0 + 2_000, 90_000), true);
  assert.equal(shouldLogWatchStatus(addr, 'wallets_below', t0 + 3_000, 90_000), false);
  assert.equal(shouldLogWatchStatus(addr, 'wallets_below', t0 + 2_000 + 90_000, 90_000), true);
});

test('seenClosed：先沒專屬、後來開了才算 justOpened', () => {
  const p = { isAgentIdExclusive: false, seenClosed: false };
  assert.equal(markSeenClosed(p), false);
  assert.equal(p.seenClosed, true);
  p.isAgentIdExclusive = true;
  assert.equal(markSeenClosed(p), true);
  assert.equal(p.seenClosed, false);
  assert.equal(markSeenClosed(p), false);
});
