import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backSellPct, decideSell, normalizeSellDecision } from '../src/policy/sell.mjs';
import { keccakHex } from '../src/lib/keccak.mjs';

const rules = {
  backX: 2,
  steps: [[10, 30], [20, 50]],
  crash: 0.4,
  crashAfterBack: 0.6,
  moonPct: 20,
  notifyX: [5, 10, 20],
  freeDrop: 0.5,
  moonNotifyX: [50, 100],
};

test('回本比例', () => {
  assert.equal(backSellPct(2, 0), 50);
  assert.equal(backSellPct(2, 20), 50);
  assert.equal(backSellPct(4, 20), 25);
});

test('付費到 2 倍回本', () => {
  const d = normalizeSellDecision(decideSell({
    paid: true, costUsd: 10, valueUsd: 21, px: 2, peakPx: 2, basePx: 1,
    backDone: false, doneSteps: [], notified: [], rules,
  }), rules);
  assert.equal(d.action, 'sell');
  assert.equal(d.tag, 'back');
  assert.equal(d.sellPct, 50);
});

test('付費回落全賣', () => {
  const d = decideSell({
    paid: true, costUsd: 10, valueUsd: 8, px: 0.5, peakPx: 1, basePx: 1,
    backDone: false, doneSteps: [], notified: [], rules,
  });
  assert.equal(d.action, 'sell');
  assert.equal(d.sellPct, 100);
});

test('免費只通知倍數', () => {
  const d = decideSell({
    paid: false, costUsd: 0, valueUsd: 0, px: 10, peakPx: 10, basePx: 1,
    backDone: false, doneSteps: [], notified: [], rules,
  });
  assert.equal(d.action, 'notify');
  assert.equal(d.notifyX, 5);
});

test('免費回落才賣', () => {
  const d = decideSell({
    paid: false, costUsd: 0, valueUsd: 0, px: 4, peakPx: 10, basePx: 1,
    backDone: false, doneSteps: [], notified: [5], rules,
  });
  assert.equal(d.action, 'sell');
  assert.equal(d.sellPct, 100);
});

test('keccak 空字串向量', () => {
  assert.equal(keccakHex(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});
