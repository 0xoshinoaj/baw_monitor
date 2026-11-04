import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES } from '../src/lib/const.mjs';
import {
  buildDiscordMessages,
  chunkText,
  createDiscord,
  DISCORD_LIMIT,
  isAlertType,
  isDiscordWebhook,
  isEmbedType,
  sendDiscordTest,
  webhookForEvent,
} from '../src/notify/discord.mjs';
import { createNotifier } from '../src/notify/notify.mjs';
import { event, isPassNotifyType } from '../src/notify/events.mjs';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
const ALERT = 'https://discord.com/api/webhooks/987654321098765432/zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONM';
const PASS = 'https://discord.com/api/webhooks/111111111111111111/passpasspasspasspasspasspasspasspasspasspasspass';

test('webhook URL 驗證', () => {
  assert.equal(isDiscordWebhook(HOOK), true);
  assert.equal(isDiscordWebhook('https://discord.com/api/webhooks/...'), false);
  assert.equal(isDiscordWebhook(''), false);
});

test('長文沿換行切且不超過 2000', () => {
  const line = 'x'.repeat(80);
  const text = Array.from({ length: 40 }, () => line).join('\n');
  const chunks = chunkText(text, DISCORD_LIMIT);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= DISCORD_LIMIT);
  assert.equal(chunks.join('\n').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('硬擋／確認／啟動用 embed', () => {
  assert.equal(isEmbedType(EVENT_TYPES.MINT_BLOCKED), true);
  assert.equal(isEmbedType(EVENT_TYPES.MINT_PENDING_CONFIRM), true);
  assert.equal(isEmbedType(EVENT_TYPES.MONITOR_STARTED), true);
  assert.equal(isAlertType(EVENT_TYPES.MINT_BLOCKED), true);
  assert.equal(isAlertType(EVENT_TYPES.MONITOR_STARTED), false);

  const msgs = buildDiscordMessages(event(EVENT_TYPES.MINT_BLOCKED, {
    title: '阻擋 20261101#00001-AWM',
    lines: ['合約資金疑似被抽光 ❌', '[0xabc](https://bscscan.com/address/0xabc)', '本日已花費 0/20 U'],
    address: '0xabc',
  }));
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].embeds?.[0]);
  assert.match(msgs[0].embeds[0].title, /^阻擋 /);
  assert.ok(!/原因：/.test(msgs[0].embeds[0].title));
  assert.match(msgs[0].embeds[0].description, /抽光/);
  assert.match(msgs[0].embeds[0].description, /bscscan\.com\/address\/0xabc/);
  assert.equal(msgs[0].embeds[0].footer.text, EVENT_TYPES.MINT_BLOCKED);
  assert.equal(msgs[0].embeds[0].fields, undefined);
});

test('embed 沒有內文地址時合約欄位連 BSCScan', () => {
  const msgs = buildDiscordMessages(event(EVENT_TYPES.MINT_BLOCKED, {
    title: '阻擋 20261101#00001-AWM',
    lines: ['連續／批量同 bytecode 部署 ❌'],
    address: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca',
  }));
  assert.equal(msgs[0].embeds[0].fields[0].name, '合約');
  assert.equal(
    msgs[0].embeds[0].fields[0].value,
    '[0xabcabcabcabcabcabcabcabcabcabcabcabcabca](https://bscscan.com/address/0xabcabcabcabcabcabcabcabcabcabcabcabcabca)',
  );
});

test('一般事件走 content 並帶 type', () => {
  const msgs = buildDiscordMessages(event(EVENT_TYPES.PROJECT_DISCOVERED, {
    title: '發現候選',
    lines: ['來源 memeRush'],
  }));
  assert.match(msgs[0].content, /\[project\.discovered\]/);
  assert.match(msgs[0].content, /發現候選/);
});

test('embed 長描述會切成多則', () => {
  const ev = event(EVENT_TYPES.MINT_BLOCKED, {
    title: '擋住',
    lines: [ 'L'.repeat(1800), 'M'.repeat(1800) ],
  });
  const msgs = buildDiscordMessages(ev);
  assert.ok(msgs.length >= 2);
  assert.ok(msgs[0].embeds);
  assert.ok(msgs[1].content);
  assert.ok((msgs[0].embeds[0].description || '').length <= DISCORD_LIMIT);
});

test('createDiscord POST JSON，警示另發 alert_webhook', async () => {
  const posts = [];
  const fetchImpl = async (url, opt) => {
    posts.push({ url, body: JSON.parse(opt.body) });
    return { ok: true, text: async () => '' };
  };
  const dc = createDiscord({
    discord: { webhook: HOOK, alert_webhook: ALERT },
  }, null, { fetchImpl });
  assert.equal(dc.enabled, true);
  await dc.emit(event(EVENT_TYPES.MINT_BLOCKED, { title: '硬擋', lines: ['原因'] }));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, HOOK);
  assert.equal(posts[1].url, ALERT);
  assert.equal(posts[0].body.username, 'baw-monitor');
  await dc.emit(event(EVENT_TYPES.MONITOR_STARTED, { title: '啟動' }));
  assert.equal(posts.length, 3);
  assert.equal(posts[2].url, HOOK);
});

test('通過／鑄造打 pass_webhook，啟動與營運 log 仍打 webhook', async () => {
  const posts = [];
  const fetchImpl = async (url, opt) => {
    posts.push({ url, body: JSON.parse(opt.body) });
    return { ok: true, text: async () => '' };
  };
  const dc = createDiscord({
    discord: { webhook: HOOK, pass_webhook: PASS },
  }, null, { fetchImpl });
  assert.equal(dc.passWebhook, PASS);
  await dc.emit(event(EVENT_TYPES.PROJECT_ELIGIBLE, { title: '達門檻' }));
  await dc.emit(event(EVENT_TYPES.MINT_PREVIEW, { title: 'preview' }));
  await dc.emit(event(EVENT_TYPES.MINT_EXECUTED, { title: '已鑄造' }));
  await dc.emit(event(EVENT_TYPES.POSITION_OPEN, { title: '開池' }));
  await dc.emit(event(EVENT_TYPES.SELL_EXECUTED, { title: '賣出' }));
  assert.equal(posts.length, 5);
  assert.ok(posts.every((p) => p.url === PASS));
  await dc.emit(event(EVENT_TYPES.MONITOR_STARTED, { title: '啟動' }));
  await dc.emit(event(EVENT_TYPES.PROJECT_DISCOVERED, { title: '發現候選' }));
  await dc.emit(event(EVENT_TYPES.MINT_BLOCKED, { title: '阻擋' }));
  await dc.emit(event(EVENT_TYPES.CMD_REPLY, { title: '指令' }));
  assert.equal(posts.length, 9);
  assert.ok(posts.slice(5).every((p) => p.url === HOOK));
});

test('沒填 pass_webhook 時通過／鑄造仍打第一顆', async () => {
  const posts = [];
  const fetchImpl = async (url) => {
    posts.push(url);
    return { ok: true, text: async () => '' };
  };
  const dc = createDiscord({ discord: { webhook: HOOK, pass_webhook: '' } }, null, { fetchImpl });
  await dc.emit(event(EVENT_TYPES.MINT_EXECUTED, { title: '已鑄造' }));
  await dc.emit(event(EVENT_TYPES.MINT_FAILED, { title: '鑄造失敗' }));
  assert.deepEqual(posts, [HOOK, HOOK]);
  assert.equal(webhookForEvent(event(EVENT_TYPES.MINT_EXECUTED, { title: 'x' }), { webhook: HOOK, passWebhook: '' }), HOOK);
  assert.equal(webhookForEvent(event(EVENT_TYPES.MINT_EXECUTED, { title: 'x' }), { webhook: HOOK, passWebhook: PASS }), PASS);
  assert.equal(webhookForEvent(event(EVENT_TYPES.MONITOR_STARTED, { title: 'x' }), { webhook: HOOK, passWebhook: PASS }), HOOK);
  assert.equal(isPassNotifyType(EVENT_TYPES.PROJECT_ELIGIBLE), true);
});

test('sendDiscordTest 送出測試通知', async () => {
  const posts = [];
  const fetchImpl = async (url, opt) => {
    posts.push({ url, body: JSON.parse(opt.body) });
    return { ok: true, text: async () => '' };
  };
  await sendDiscordTest(HOOK, { fetchImpl });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, HOOK);
  assert.match(posts[0].body.content, /測試通知/);
});

test('沒 Discord 沒 TG 只當關閉', async () => {
  const n = createNotifier({ telegram: {}, discord: {} }, { info() {}, warn() {} });
  assert.equal(n.enabled, false);
  await n.emit(event(EVENT_TYPES.MONITOR_STARTED, { title: '啟動' }));
});
