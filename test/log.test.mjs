import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpc } from '../src/chain/rpc.mjs';
import { logHeatCandidates } from '../src/discovery/heat.mjs';
import { createLogger, isRpcLogNoise, stripAnsi } from '../src/lib/log.mjs';
import { EVENT_TYPES } from '../src/lib/const.mjs';
import { event } from '../src/notify/events.mjs';
import { createNotifier } from '../src/notify/notify.mjs';

function withConsole(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    return { lines, result: fn() };
  } finally {
    console.log = orig;
  }
}

function tmpLog() {
  return join(mkdtempSync(join(tmpdir(), 'baw-log-')), 'monitor.log');
}

function read(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

test('isRpcLogNoise 辨識 RPC／節點關鍵字，狀態列不算', () => {
  assert.equal(isRpcLogNoise('RPC eth_getLogs 失敗 1rpc.io：HTTP 429，冷卻 60s'), true);
  assert.equal(isRpcLogNoise('RPC eth_getBlockByNumber 失敗 bsc.publicnode.com：fetch failed'), true);
  assert.equal(isRpcLogNoise('RPC 尚未就緒：全部節點失敗'), true);
  assert.equal(isRpcLogNoise('鑄造事件 getLogs 失敗，本輪跳過、游標不推進：RPC eth_getLogs 全部節點失敗'), true);
  assert.equal(isRpcLogNoise('getLogs 專用節點失敗'), true);
  assert.equal(isRpcLogNoise('節點 chainId=0x1，預期 0x38'), true);
  assert.equal(isRpcLogNoise('追蹤 20261101#00003-Rush 免費 進度 48%/50% 錢包 20/100 先追蹤'), false);
  assert.equal(isRpcLogNoise('被策略阻擋 20261101#00001-AWM 原因：合約資金疑似被抽光'), false);
  assert.equal(isRpcLogNoise('[w1] 已鑄造 FOO tx=0xabc'), false);
  assert.equal(isRpcLogNoise('notify(off) project.discovered 發現候選'), false);
});

test('狀態 INFO 寫進檔，格式接近終端且無 ANSI', () => {
  const file = tmpLog();
  const { lines } = withConsole(() => {
    const log = createLogger({ file, timeZone: 'Asia/Taipei' });
    log.info('追蹤 20261101#00003-Rush 免費 進度 48%/50% 錢包 20/100 先追蹤');
    log.info('啟動 baw-monitor');
    log.info('\x1B[31m已鑄造 FOO\x1B[0m');
  });
  const text = read(file);
  assert.match(text, /追蹤 20261101#00003-Rush/);
  assert.match(text, /啟動 baw-monitor/);
  assert.match(text, /已鑄造 FOO/);
  assert.doesNotMatch(text, /\x1B\[/);
  assert.ok(lines.some((l) => /INFO 追蹤 20261101#00003-Rush/.test(l)));
  assert.match(text, /INFO 追蹤 20261101#00003-Rush/);
});

test('RPC warn 進終端、不進檔', () => {
  const file = tmpLog();
  const { lines } = withConsole(() => {
    const log = createLogger({ file, timeZone: 'Asia/Taipei' });
    log.warn('RPC eth_getLogs 失敗 1rpc.io：HTTP 429，冷卻 60s');
    log.warn('RPC eth_getBlockByNumber 失敗 bsc.publicnode.com：fetch failed');
    log.warn('RPC 尚未就緒：RPC eth_getLogs 全部節點失敗');
    log.warn('鑄造事件 getLogs 失敗，本輪跳過、游標不推進：timeout');
    log.info('追蹤 Foo 先追蹤');
    log.warn('Discord 發送失敗：網路斷了');
  });
  const text = read(file);
  assert.doesNotMatch(text, /RPC/);
  assert.doesNotMatch(text, /eth_getLogs/);
  assert.doesNotMatch(text, /eth_getBlock/);
  assert.doesNotMatch(text, /429/);
  assert.doesNotMatch(text, /冷卻/);
  assert.doesNotMatch(text, /getLogs/);
  assert.match(text, /追蹤 Foo 先追蹤/);
  assert.match(text, /Discord 發送失敗/);
  assert.ok(lines.some((l) => /WARN RPC eth_getLogs/.test(l)));
  assert.ok(lines.some((l) => /WARN RPC eth_getBlockByNumber/.test(l)));
});

test('createRpc 的 429 warn 不進檔', async () => {
  const file = tmpLog();
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  const captured = [];
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  console.log = (s) => captured.push(String(s));
  try {
    const log = createLogger({ file, timeZone: 'Asia/Taipei' });
    const rpc = createRpc(['https://example.invalid/rpc'], log);
    try { await rpc.getBlock(1, false); } catch { /* 預期失敗 */ }
    const text = read(file);
    assert.doesNotMatch(text, /RPC|429|eth_getBlock|冷卻/);
    assert.ok(captured.some((l) => /RPC eth_getBlockByNumber/.test(l) && /429/.test(l)));
  } finally {
    globalThis.fetch = origFetch;
    console.log = origLog;
  }
});

test('熱度逐址只進終端，摘要進檔', () => {
  const file = tmpLog();
  const { lines } = withConsole(() => {
    const log = createLogger({ file, timeZone: 'Asia/Taipei' });
    logHeatCandidates(log, [
      { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ref: '20261101#00002-FOO', symbol: 'FOO' },
      { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ref: '20261101#00003-BAR' },
    ]);
  });
  const text = read(file);
  assert.match(text, /熱度掃描候選 2 個：/);
  assert.doesNotMatch(text, /0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(text, /20261101#00002-FOO/);
  assert.ok(lines.some((l) => /20261101#00002-FOO/.test(l)));
});

test('通知開啟時事件仍寫進檔、終端不重複印', async () => {
  const file = tmpLog();
  const orig = console.log;
  const captured = [];
  console.log = (s) => captured.push(String(s));
  try {
    const log = createLogger({ file, timeZone: 'Asia/Taipei' });
    const n = createNotifier({
      telegram: {},
      discord: { webhook: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN' },
    }, log, {
      fetchImpl: async () => ({ ok: true, text: async () => '' }),
    });
    assert.equal(n.enabled, true);
    await n.emit(event(EVENT_TYPES.PROJECT_DISCOVERED, { title: '發現候選 20261101#00002-FOO' }));
    const text = read(file);
    assert.match(text, /notify project\.discovered 發現候選 20261101#00002-FOO/);
    assert.ok(!captured.some((l) => /notify project\.discovered/.test(l)));
  } finally {
    console.log = orig;
  }
});

test('stripAnsi 去掉色碼', () => {
  assert.equal(stripAnsi('\x1B[31mWARN\x1B[0m 你好'), 'WARN 你好');
});
