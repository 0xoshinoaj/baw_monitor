import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBestProgress, progressFromInventory, progressFromListing,
  progressFromSoldCap, progressFromUnits, thresholdsMet,
} from '../src/classify/progress.mjs';

test('已售／上限', () => {
  const p = progressFromSoldCap(60, 100);
  assert.equal(p.reliable, true);
  assert.equal(p.pct, 60);
});

test('不合理上限丟棄', () => {
  assert.equal(progressFromSoldCap(10, 5).reliable, false);
  assert.equal(progressFromSoldCap(-1, 100).reliable, false);
  assert.equal(progressFromSoldCap(1, 1e20).reliable, false);
});

test('庫存剩餘', () => {
  const p = progressFromInventory(1000n, 400n);
  assert.equal(p.reliable, true);
  assert.equal(p.pct, 60);
  assert.equal(progressFromInventory(0n, 0n).reliable, false);
  assert.equal(progressFromInventory(10n, 20n).reliable, false);
});

test('份數算法', () => {
  const p = progressFromUnits(1000n, 400n, 10n, 100);
  assert.equal(p.reliable, true);
  assert.equal(p.sold, 60);
  assert.equal(p.pct, 60);
});

test('listing 進度不乘 100', () => {
  const p = progressFromListing('12.5');
  assert.equal(p.pct, 12.5);
  assert.equal(progressFromListing(null).reliable, false);
});

test('優先採用 soldCap', () => {
  const best = pickBestProgress([
    progressFromInventory(100n, 10n),
    progressFromSoldCap(80, 100),
  ]);
  assert.equal(best.how, 'soldCap');
  assert.equal(best.pct, 80);
});

test('門檻：進度 + Agent ID 錢包', () => {
  const cfg = { thresholds: { progressPct: 60, agentIdWallets: 100 } };
  const ok = thresholdsMet({ pct: 70, reliable: true }, { agentIdWallets: 120 }, cfg);
  assert.equal(ok.ok, true);
  const no = thresholdsMet({ pct: 50, reliable: true }, { agentIdWallets: 200 }, cfg);
  assert.equal(no.ok, false);
  assert.match(no.reasons.join('；'), /鑄造進度 50% 未達 60%/);
  const lowBoth = thresholdsMet({ pct: 12, reliable: true }, { agentIdWallets: 8 }, cfg);
  assert.match(lowBoth.reasons.join('；'), /鑄造進度 12% 未達 60%/);
  assert.match(lowBoth.reasons.join('；'), /Agent ID 錢包數 8 未達 100/);
  const heatOnly = thresholdsMet({ pct: null, reliable: false }, { agentIdWallets: 100 }, cfg);
  assert.equal(heatOnly.ok, true);
});
