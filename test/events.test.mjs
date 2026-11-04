import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/policy/rules.mjs';
import { EVENT_TYPES } from '../src/lib/const.mjs';
import {
  formatBlockedLines,
  formatBlockedTitle,
  formatBscscanLink,
  formatNotifyAmount,
  formatStartupLines,
  formatWalletLine,
  isPassNotifyType,
} from '../src/notify/events.mjs';

const cfg = {
  execution: { free: 'notify', paid: 'notify' },
  thresholds: { progressPct: 50, agentIdWallets: 100, requirePerWalletCap: true },
  budget: { maxUsdPerProject: 3, maxUsdPerDay: 20, keepBnb: 0.006 },
  wallets: [{ name: 'oshinoaj.ai', address: '0xaa4d88f35efd271b65deee9b8eaea4d66c897597' }],
};

function project(extra = {}) {
  return {
    address: '0x9ff81a644adbcdc836e26078a5a9b47f15f9752a',
    symbol: 'JUPIBEAR',
    ref: '20261102#04828-JUPIBEAR',
    kind: 'free',
    paid: false,
    isAgentIdExclusive: true,
    progress: { pct: null, reliable: false },
    heat: { agentIdWallets: 17 },
    risk: { flags: [], drain: false, serial: false, blacklist: false },
    mint: { perWalletCap: 1 },
    walletState: {},
    ...extra,
  };
}

test('啟動通知含完整錢包址、config 門檻與通過通知狀態', () => {
  const lines = formatStartupLines(cfg);
  assert.equal(lines[0], '執行模式：免費=notify 付費=notify');
  assert.equal(
    lines[1],
    '錢包：oshinoaj.ai([0xaa4d88f35efd271b65deee9b8eaea4d66c897597](https://bscscan.com/address/0xaa4d88f35efd271b65deee9b8eaea4d66c897597))',
  );
  assert.equal(lines[2], '發現來源：鑄造進度 50%、.ai錢包 100、日額 20U、免費 notify／付費 notify');
  assert.equal(lines[3], '通過通知：未設定');
  assert.equal(formatStartupLines({
    ...cfg,
    discord: { pass_webhook: 'https://discord.com/api/webhooks/1/token' },
  })[3], '通過通知：已設定');
});

test('通過／鑄造事件走 pass 頻道，營運 log 不走', () => {
  for (const t of [
    EVENT_TYPES.PROJECT_ELIGIBLE,
    EVENT_TYPES.MINT_PENDING_CONFIRM,
    EVENT_TYPES.MINT_PREVIEW,
    EVENT_TYPES.MINT_EXECUTED,
    EVENT_TYPES.MINT_FAILED,
    EVENT_TYPES.POSITION_OPEN,
    EVENT_TYPES.POSITION_MULTIPLE,
    EVENT_TYPES.SELL_EXECUTED,
    EVENT_TYPES.SELL_FAILED,
  ]) {
    assert.equal(isPassNotifyType(t), true, t);
  }
  for (const t of [
    EVENT_TYPES.MONITOR_STARTED,
    EVENT_TYPES.PROJECT_DISCOVERED,
    EVENT_TYPES.MINT_BLOCKED,
    EVENT_TYPES.SESSION_LOGIN,
    EVENT_TYPES.SESSION_DEVMODE,
    EVENT_TYPES.SESSION_LOW_BNB,
    EVENT_TYPES.CMD_REPLY,
    EVENT_TYPES.RISK_DRAIN,
    EVENT_TYPES.RISK_SERIAL,
  ]) {
    assert.equal(isPassNotifyType(t), false, t);
  }
});

test('啟動門檻用實際 config，不寫死', () => {
  const lines = formatStartupLines({
    ...cfg,
    execution: { free: 'notify', paid: 'auto' },
    thresholds: { progressPct: 60, agentIdWallets: 80 },
    budget: { maxUsdPerDay: 200 },
    wallets: [{ name: 'alice.ai', address: '0x1111111111111111111111111111111111111111' }],
  });
  assert.match(lines[0], /付費=auto/);
  assert.match(lines[1], /alice\.ai/);
  assert.equal(lines[2], '發現來源：鑄造進度 60%、.ai錢包 80、日額 200U、免費 notify／付費 auto');
});

test('阻擋範例 A：讀不到進度改看熱度', () => {
  const p = project();
  const d = decide(p, cfg, {});
  assert.equal(formatBlockedTitle(p, d.reason), '阻擋 20261102#04828-JUPIBEAR');
  assert.deepEqual(formatBlockedLines(p, cfg, {}, { decision: d }), [
    '進度條無法讀取，改確認錢包熱度',
    '.ai錢包數 17/100 ❌',
    '[0x9ff81a644adbcdc836e26078a5a9b47f15f9752a](https://bscscan.com/address/0x9ff81a644adbcdc836e26078a5a9b47f15f9752a)',
    '本日已花費 0/20 U',
  ]);
});

test('阻擋範例 B：進度與錢包都未達', () => {
  const p = project({
    address: '0xcbe2dbbff4264dc67bf557c64e29997b82439354',
    symbol: 'BAO-NFT',
    ref: '20261102#03973-BAO-NFT',
    progress: { pct: 39.8, reliable: true },
    heat: { agentIdWallets: 8 },
  });
  const d = decide(p, cfg, {});
  assert.equal(formatBlockedTitle(p), '阻擋 20261102#03973-BAO-NFT');
  assert.deepEqual(formatBlockedLines(p, cfg, {}, { decision: d }), [
    '鑄造進度 39.8% / 50% ❌',
    '.ai錢包數 8/100 ❌',
    '[0xcbe2dbbff4264dc67bf557c64e29997b82439354](https://bscscan.com/address/0xcbe2dbbff4264dc67bf557c64e29997b82439354)',
    '本日已花費 0/20 U',
  ]);
});

test('連續部署與日額超支寫在內文', () => {
  const p = project({
    risk: { flags: ['serialBytecode'], drain: false, serial: true, blacklist: false },
  });
  const d = decide(p, cfg, { spendUsd: { w1: 20 } }, { walletName: 'w1' });
  const lines = formatBlockedLines(p, cfg, { spendUsd: { w1: 20 } }, { walletName: 'w1', decision: d });
  assert.deepEqual(lines, [
    '連續／批量同 bytecode 部署 ❌',
    '[0x9ff81a644adbcdc836e26078a5a9b47f15f9752a](https://bscscan.com/address/0x9ff81a644adbcdc836e26078a5a9b47f15f9752a)',
    '本日已花費 20/20 U ❌',
  ]);
});

test('花費去掉多餘小數', () => {
  assert.equal(formatNotifyAmount(0), '0');
  assert.equal(formatNotifyAmount(20), '20');
  assert.equal(formatNotifyAmount(20.00), '20');
  assert.equal(formatNotifyAmount(1.5), '1.5');
  assert.equal(formatBscscanLink('0xabc'), '[0xabc](https://bscscan.com/address/0xabc)');
  assert.equal(formatWalletLine([]), '錢包：未設定');
});
