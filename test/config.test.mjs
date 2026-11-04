import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectMissing,
  isPlaceholderAddress,
  isPlaceholderName,
  isPlaceholderWebhook,
  loadConfig,
  normalizeConfig,
  ROOT,
} from '../src/config.mjs';

const ADDR = '0x1111111111111111111111111111111111111111';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'baw-cfg-'));
}

test('佔位符判斷', () => {
  assert.equal(isPlaceholderName(''), true);
  assert.equal(isPlaceholderName('mywallet.ai'), true);
  assert.equal(isPlaceholderName('real.ai'), false);
  assert.equal(isPlaceholderAddress('0xYourAgentWallet'), true);
  assert.equal(isPlaceholderAddress(ADDR), false);
  assert.equal(isPlaceholderWebhook(''), true);
  assert.equal(isPlaceholderWebhook('https://discord.com/api/webhooks/...'), true);
  assert.equal(isPlaceholderWebhook(HOOK), false);
});

test('讀 TOML 並合併預設', () => {
  const dir = tmp();
  const path = join(dir, 'config.toml');
  writeFileSync(path, `
timeZone = "Asia/Taipei"
[[wallets]]
name = "real.ai"
address = "${ADDR}"
[discord]
webhook = "${HOOK}"
pass_webhook = ""
[execution]
free = "confirm"
paid = "auto"
[sell]
steps = [[10, 30], [20, 50]]
`);
  const cfg = loadConfig(path);
  assert.equal(cfg.wallets[0].name, 'real.ai');
  assert.equal(cfg.wallets[0].address, ADDR);
  assert.equal(cfg.discord.webhook, HOOK);
  assert.equal(cfg.discord.pass_webhook, '');
  assert.equal(cfg.execution.free, 'confirm');
  assert.equal(cfg.budget.maxUsdPerDay, 200);
  assert.deepEqual(cfg.sell.steps, [[10, 30], [20, 50]]);
  assert.equal(cfg.discovery.memeRush.enabled, true);
  assert.equal(cfg.discovery.mintEvents.enabled, true);
  assert.equal(cfg.discovery.mintEvents.windowMs, 900_000);
  assert.equal(cfg.discovery.mintEvents.intervalMs, 0);
  assert.equal(cfg.discovery.mintEvents.lookbackBlocks, 60);
  assert.equal(cfg.discovery.heat.windowMs, 180_000);
  assert.ok(cfg.rpcs.length > 0);
});

test('讀 example.toml 結構完整', () => {
  const cfg = loadConfig(join(ROOT, 'config.example.toml'), { strict: false });
  assert.equal(cfg.wallets[0].name, 'mywallet.ai');
  assert.equal(cfg.execution.free, 'notify');
  assert.equal(cfg.execution.paid, 'auto');
  assert.equal(cfg.discovery.mintEvents.windowMs, 900_000);
  assert.equal(cfg.discovery.mintEvents.intervalMs, 0);
  assert.equal(cfg.discovery.mintEvents.lookbackBlocks, 60);
  assert.equal(cfg.discovery.heat.windowMs, 180_000);
  assert.equal(cfg.discord.pass_webhook, '');
  assert.ok(!collectMissing(cfg).some((m) => m.id === 'discord.webhook'));
  assert.ok(collectMissing(cfg).some((m) => m.id === 'wallet.address'));
  assert.ok(collectMissing(cfg).some((m) => m.id === 'wallet.name'));
});

test('舊 JSON 可一次讀入', () => {
  const dir = tmp();
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    wallets: [{ name: 'old.ai', address: ADDR }],
    telegram: { botToken: 't', chatId: '1' },
  }));
  const warns = [];
  const cfg = loadConfig(path, { warn: (m) => warns.push(m) });
  assert.equal(cfg.wallets[0].name, 'old.ai');
  assert.match(warns.join('\n'), /config\.json/);
});

test('預設路徑找不到就丟錯', () => {
  assert.throws(() => loadConfig(join(tmp(), 'config.toml')), /找不到/);
});

test('normalize 嚴格模式拒絕非法錢包', () => {
  assert.throws(() => normalizeConfig({ wallets: [] }), /至少要有一個/);
  assert.throws(() => normalizeConfig({ wallets: [{ name: 'x', address: 'nope' }] }), /合法 address/);
});

test('collectMissing 完整設定為空', () => {
  const cfg = normalizeConfig({
    wallets: [{ name: 'real.ai', address: ADDR }],
    discord: { webhook: HOOK },
  }, { strict: true });
  assert.deepEqual(collectMissing(cfg), []);
});

test('collectMissing 空 webhook 不算缺', () => {
  const cfg = normalizeConfig({
    wallets: [{ name: 'real.ai', address: ADDR }],
    discord: { webhook: '' },
  }, { strict: true });
  assert.deepEqual(collectMissing(cfg), []);
});

test('example 檔含繁中註解', () => {
  const text = readFileSync(join(ROOT, 'config.example.toml'), 'utf8');
  assert.match(text, /錢包/);
  assert.doesNotMatch(text, /錦包/);
  assert.match(text, /Agent ID/);
  assert.match(text, /自動帶入/);
  assert.match(text, /可略過/);
  assert.match(text, /個人通知/);
  assert.match(text, /\[discord\]/);
  assert.match(text, /pass_webhook/);
  assert.match(text, /通過／鑄造/);
  assert.match(text, /log 頻道/);
  assert.doesNotMatch(text, /config\.example\.json/);
});

test('讀 pass_webhook 與 passWebhook 別名', () => {
  const a = normalizeConfig({
    wallets: [{ name: 'real.ai', address: ADDR }],
    discord: { webhook: HOOK, pass_webhook: HOOK },
  });
  assert.equal(a.discord.pass_webhook, HOOK);
  const b = normalizeConfig({
    wallets: [{ name: 'real.ai', address: ADDR }],
    discord: { webhook: HOOK, passWebhook: HOOK },
  });
  assert.equal(b.discord.pass_webhook, HOOK);
});
