import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isSerialFingerprint, noteFingerprint, strategyBlockReason } from '../src/policy/rules.mjs';

const cfg = {
  execution: { free: 'notify', paid: 'auto' },
  thresholds: { progressPct: 60, agentIdWallets: 100, requirePerWalletCap: true },
  budget: { maxUsdPerProject: 20, maxUsdPerDay: 200, keepBnb: 0.006 },
};

const base = {
  address: '0xabc',
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

test('免費預設只通知', () => {
  const d = decide(base, cfg, {});
  assert.equal(d.action, 'notify');
  assert.equal(d.mode, 'notify');
  assert.equal(d.paid, false);
});

test('付費達標後 auto', () => {
  const d = decide({ ...base, kind: 'bonding', paid: true }, cfg, {});
  assert.equal(d.action, 'auto');
  assert.equal(d.mode, 'auto');
  assert.equal(d.paid, true);
});

test('未達門檻忽略', () => {
  const d = decide({ ...base, progress: { pct: 10, reliable: true } }, cfg, {});
  assert.equal(d.action, 'ignore');
  assert.match(d.reason, /鑄造進度 10% 未達 60%/);
  assert.match(strategyBlockReason(d), /鑄造進度 10% 未達 60%/);
});

test('抽光硬擋', () => {
  const d = decide({ ...base, kind: 'bnb', paid: true, risk: { ...base.risk, drain: true } }, cfg, {});
  assert.equal(d.action, 'block');
});

test('黑名單硬擋', () => {
  const d = decide(base, cfg, { blacklist: ['0xdef'] });
  assert.equal(d.action, 'block');
});

test('每日預算用盡', () => {
  const d = decide({ ...base, kind: 'bonding', paid: true }, cfg, { spendUsd: { w1: 200 } }, { walletName: 'w1' });
  assert.equal(d.action, 'block');
});

test('confirm 模式', () => {
  const c = { ...cfg, execution: { free: 'confirm', paid: 'confirm' } };
  const d = decide(base, c, {});
  assert.equal(d.action, 'confirm');
});

test('付費缺每錢包上限 → 只通知', () => {
  const d = decide({ ...base, kind: 'bnb', paid: true, mint: { perWalletCap: null } }, cfg, {});
  assert.equal(d.action, 'notify');
  assert.equal(d.reason, '付費合約沒有每錢包／每筆上限');
  assert.equal(strategyBlockReason(d), '付費合約沒有每錢包／每筆上限');
});

test('bonding 視為已有上限', () => {
  const d = decide({ ...base, kind: 'bonding', paid: true, mint: { perWalletCap: 1 } }, cfg, {});
  assert.equal(d.action, 'auto');
});

test('指紋連續部署', () => {
  const risk = { fingerprints: {} };
  noteFingerprint(risk, 'fp', 1);
  noteFingerprint(risk, 'fp', 2);
  noteFingerprint(risk, 'fp', 3);
  assert.equal(isSerialFingerprint(risk, 'fp', 3, 4), true);
});
