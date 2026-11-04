import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ROOT } from '../src/config.mjs';
import {
  applyAnswersToToml,
  applyLegacyJsonToToml,
  bootstrap,
  ensureConfigFile,
  ensureOneWallet,
  formatAgentIdLine,
  formatDevModeLine,
  promptMissing,
  runLogin,
  SetupError,
  UserQuit,
} from '../src/setup/bootstrap.mjs';
import { green, red, yellow } from '../src/setup/ansi.mjs';
import {
  fetchAndApplyIdentity,
  normalizeAgentName,
  parseAgentIdJson,
  parseBscAddressJson,
  shortAddr,
  shouldPromptIdentity,
} from '../src/setup/identity.mjs';
import { formatTomlValue, patchTomlKey } from '../src/setup/toml-patch.mjs';

const ADDR = '0x1111111111111111111111111111111111111111';
const ADDR2 = '0x2222222222222222222222222222222222222222';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
const EXAMPLE = join(ROOT, 'config.example.toml');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'baw-boot-'));
}

function muteIO() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = false;
  stdout.isTTY = false;
  let out = '';
  stdout.on('data', (c) => { out += c; });
  return { stdin, stdout, output: () => out };
}

function ttyAsk(lines) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = true;
  stdout.isTTY = true;
  let out = '';
  stdout.on('data', (c) => { out += c; });
  let i = 0;
  const ask = async () => {
    const v = lines[i++];
    if (v == null) throw new Error('提問次數超過準備的答案');
    return v;
  };
  return { stdin, stdout, ask, output: () => out };
}

function mockBaw({
  status = 'CONNECTED',
  dev = true,
  claimed = true,
  expiresAt = Date.now() + 86400_000,
  agentId = 'real.ai',
  handle = 'real',
  address = ADDR,
} = {}) {
  return {
    wallet: { name: 'mywallet.ai', address: '0xYourAgentWallet' },
    status: async () => ({ j: { data: { status } }, t: '' }),
    settings: async () => ({ j: { data: { devMode: { enabled: dev, expiresAt } } }, t: '' }),
    agentId: async () => ({
      j: { success: true, data: claimed ? { claimed, handle, agentId } : { claimed: false } },
      t: '',
    }),
    address: async () => ({
      j: { success: true, data: { addresses: [{ binanceChainId: '56', chainName: 'BSC', address }] } },
      t: '',
    }),
    signin: async () => ({ j: { data: { qrCodeId: 'q1', urlForWeb: 'https://login.example', pairingCode: 'AB' } }, t: '' }),
    verify: async () => ({ j: { data: { status: 'SUCCESS' } }, t: '' }),
  };
}

test('patch 保留行尾註解', () => {
  const src = `[discord]\nwebhook = ""  # 個人通知\n`;
  const out = patchTomlKey(src, '[discord]', 'webhook', HOOK);
  assert.match(out, /個人通知/);
  assert.match(out, /webhook = "/);
  assert.match(out, /discord\.com/);
});

test('patch 數字與陣列不強制加引號', () => {
  const src = `[thresholds]\nprogressPct = 60  # 進度\n[sell]\nsteps = [[10, 30], [20, 50]]\n`;
  const out = patchTomlKey(patchTomlKey(src, '[thresholds]', 'progressPct', 80), '[sell]', 'steps', [[10, 40], [20, 50]]);
  assert.match(out, /progressPct = 80  # 進度/);
  assert.match(out, /steps = \[\[10, 40\], \[20, 50\]\]/);
  assert.equal(formatTomlValue(true), 'true');
});

test('applyAnswers 只改必要欄位', () => {
  const src = readFileSync(EXAMPLE, 'utf8');
  const out = applyAnswersToToml(src, [
    { header: '[[wallets]]', key: 'name', value: 'real.ai' },
    { header: '[[wallets]]', key: 'address', value: ADDR },
    { header: '[discord]', key: 'webhook', value: HOOK },
  ]);
  assert.match(out, /name = "real\.ai"/);
  assert.match(out, new RegExp(ADDR));
  assert.match(out, /錢包/);
  assert.doesNotMatch(out, /錦包/);
  assert.match(out, /免費與付費分開/);
  assert.match(out, /backX = 2/);
});

test('舊 JSON 寫入 example 時保留註解', () => {
  const src = readFileSync(EXAMPLE, 'utf8');
  const out = applyLegacyJsonToToml(src, {
    wallets: [{ name: 'old.ai', address: ADDR }],
    telegram: { botToken: 'tok', chatId: '99' },
  });
  assert.match(out, /old\.ai/);
  assert.match(out, /botToken = "tok"/);
  assert.match(out, /選用/);
});

test('非 TTY 且無 config：複製 example 後可繼續（不要求先填）', async () => {
  const dir = tmp();
  const io = muteIO();
  const cfg = await ensureConfigFile({ root: dir, examplePath: EXAMPLE, ...io });
  assert.equal(existsSync(join(dir, 'config.toml')), true);
  assert.equal(cfg.wallets[0].name, 'mywallet.ai');
  assert.match(readFileSync(join(dir, 'config.toml'), 'utf8'), /錢包/);
  assert.doesNotMatch(readFileSync(join(dir, 'config.toml'), 'utf8'), /錦包/);
  assert.match(io.output(), /自動帶入/);
});

test('非 TTY 且缺 webhook：不算缺設定', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8')
    .replace('mywallet.ai', 'real.ai')
    .replace('0xYourAgentWallet', ADDR));
  const io = muteIO();
  const cfg = await ensureConfigFile({ root: dir, examplePath: EXAMPLE, ...io });
  assert.equal(cfg.wallets[0].name, 'real.ai');
  assert.equal(cfg.discord.webhook, '');
});

test('TTY 不再先問名稱／地址／webhook', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8'));
  const io = ttyAsk([]);
  const cfg = await ensureConfigFile({ root: dir, examplePath: EXAMPLE, ...io });
  assert.equal(cfg.wallets[0].name, 'mywallet.ai');
  assert.equal(cfg.discord.webhook, '');
});

test('舊 JSON 非 TTY 但欄位齊：轉成 toml', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    wallets: [{ name: 'old.ai', address: ADDR }],
    discord: { webhook: HOOK },
  }));
  const io = muteIO();
  const cfg = await ensureConfigFile({ root: dir, examplePath: EXAMPLE, ...io });
  assert.equal(cfg.wallets[0].name, 'old.ai');
  assert.equal(existsSync(join(dir, 'config.toml')), true);
});

test('shortAddr 例：0xaa4d...7597', () => {
  assert.equal(shortAddr('0xaa4d000000000000000000000000000000007597'), '0xaa4d...7597');
});

test('關色時顏色函式不含 ANSI', () => {
  const off = { isTTY: false };
  assert.equal(green('https://login.example', off), 'https://login.example');
  assert.equal(yellow('AB12', off), 'AB12');
  assert.equal(red('err', off), 'err');
  const noColorEnv = { env: { NO_COLOR: '1' } };
  assert.equal(green('x', { isTTY: true }, noColorEnv), 'x');
  assert.equal(yellow('x', { isTTY: true }, noColorEnv), 'x');
  assert.match(green('x', { isTTY: true }, { env: {} }), /^\u001b\[32mx\u001b\[0m$/);
  assert.match(yellow('x', { isTTY: true }, { env: {} }), /^\u001b\[33mx\u001b\[0m$/);
});

test('狀態列 ✅／❌ 分開寫開發者模式與 Agent ID', () => {
  assert.equal(formatDevModeLine('oshinoaj.ai', true), '[oshinoaj.ai] ✅ 開發者模式已開');
  assert.equal(formatDevModeLine('oshinoaj.ai', false), '[oshinoaj.ai] ❌ 開發者模式未開');
  assert.equal(formatAgentIdLine('oshinoaj.ai', true, 'oshinoaj.ai'), '[oshinoaj.ai] ✅ Agent ID 已領取（oshinoaj.ai）');
  assert.equal(formatAgentIdLine('oshinoaj.ai', false), '[oshinoaj.ai] ❌ Agent ID 未領取');
});

test('已登入通過時印出 ✅ 狀態列', async () => {
  const io = muteIO();
  await ensureOneWallet(mockBaw({ agentId: 'oshinoaj.ai' }), { interactive: false, ...io });
  const out = io.output();
  assert.match(out, /\[oshinoaj\.ai\] ✅ 開發者模式已開/);
  assert.match(out, /\[oshinoaj\.ai\] ✅ Agent ID 已領取（oshinoaj\.ai）/);
  assert.doesNotMatch(out, /開發者模式已開，Agent ID 已領取/);
});

test('已登入但沒開發者模式 → 清楚拒絕', async () => {
  const io = muteIO();
  await assert.rejects(
    () => ensureOneWallet(mockBaw({ dev: false }), { interactive: false, ...io }),
    (e) => e instanceof SetupError && /開發者模式/.test(e.message) && /不能當成已就緒/.test(e.message),
  );
});

test('已登入但沒 Agent ID → 清楚拒絕且說明 .ai', async () => {
  const io = muteIO();
  await assert.rejects(
    () => ensureOneWallet(mockBaw({ claimed: false }), { interactive: false, ...io }),
    (e) => e instanceof SetupError && /Agent ID/.test(e.message) && /\.ai/.test(e.message) && /幣安 App/.test(e.message),
  );
  assert.match(io.output(), /❌ Agent ID 未領取/);
});

test('CLI 後端暫時不可用不要說未領取', async () => {
  const baw = mockBaw();
  baw.agentId = async () => ({ j: { success: false, code: '20003008', message: 'busy' }, t: '' });
  const io = muteIO();
  await assert.rejects(
    () => ensureOneWallet(baw, { interactive: false, ...io }),
    (e) => e instanceof SetupError && /暫時無法使用/.test(e.message) && !/Agent ID 未領取/.test(e.message),
  );
  assert.doesNotMatch(io.output(), /Agent ID 未領取/);
  assert.match(io.output(), /暫時無法使用/);
});

test('互動：開發者模式未開會進引導，Enter 重查通過後才繼續', async () => {
  let n = 0;
  const baw = mockBaw({ claimed: true, agentId: 'oshinoaj.ai' });
  baw.settings = async () => {
    n += 1;
    return { j: { data: { devMode: { enabled: n > 1, expiresAt: Date.now() + 86400_000 } } }, t: '' };
  };
  const asked = [];
  const io = ttyAsk([]);
  const ok = await ensureOneWallet(baw, {
    interactive: true,
    ...io,
    ask: async (label) => {
      asked.push(label);
      return '';
    },
  });
  assert.equal(ok, true);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Enter/);
  const out = io.output();
  assert.match(out, /❌ 開發者模式未開/);
  assert.match(out, /✅ 開發者模式已開/);
  assert.match(out, /Agentic Wallet/);
  assert.match(out, /確認風險/);
  assert.doesNotMatch(out, /1\) 開始監控/);
});

test('互動：未領 Agent ID 會進引導，選結束不進選單', async () => {
  const io = ttyAsk(['結束']);
  await assert.rejects(
    () => ensureOneWallet(mockBaw({ claimed: false }), { interactive: true, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const out = io.output();
  assert.match(out, /❌ Agent ID 未領取/);
  assert.match(out, /Web3 錢包/);
  assert.match(out, /領取 \.ai/);
  assert.doesNotMatch(out, /1\) 開始監控/);
  assert.doesNotMatch(out, /開始監控/);
});

test('互動 bootstrap：未開開發者模式不會進主選單', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8'));
  const io = ttyAsk(['結束']);
  await assert.rejects(
    () => bootstrap({
      root: dir,
      examplePath: EXAMPLE,
      createClient: () => mockBaw({ dev: false }),
      ...io,
    }),
    (e) => e instanceof UserQuit,
  );
  const out = io.output();
  assert.match(out, /❌ 開發者模式未開/);
  assert.match(out, /開啟開發者模式/);
  assert.doesNotMatch(out, /1\) 開始監控/);
});

test('未登入且非 TTY → 不卡 readline', async () => {
  const io = muteIO();
  await assert.rejects(
    () => ensureOneWallet(mockBaw({ status: 'DISCONNECTED' }), { interactive: false, ...io }),
    (e) => e instanceof SetupError && /尚未登入/.test(e.message),
  );
});

test('互動登入成功', async () => {
  const io = muteIO();
  const baw = mockBaw({ status: 'DISCONNECTED' });
  const ok = await runLogin(baw, io);
  assert.equal(ok, true);
  assert.match(io.output(), /login\.example/);
  assert.doesNotMatch(io.output(), /\u001b\[/);
});

test('登入輸出含網址與配對碼', async () => {
  const io = ttyAsk([]);
  const ok = await runLogin(mockBaw({ status: 'DISCONNECTED' }), io);
  assert.equal(ok, true);
  const out = io.output();
  assert.match(out, /https:\/\/login\.example/);
  assert.match(out, /配對碼：AB/);
});

test('無效 webhook 會重問', async () => {
  const asked = [];
  const answers = ['not-a-hook', HOOK];
  const io = muteIO();
  const got = await promptMissing(
    [{ id: 'discord.webhook', header: '[discord]', key: 'webhook', label: 'Discord webhook' }],
    { ...io, ask: async (label) => { asked.push(label); return answers.shift(); } },
  );
  assert.equal(got[0].value, HOOK);
  assert.equal(asked.length, 2);
  assert.match(io.output(), /必須是 Discord webhook/);
});

test('通過後 bootstrap skipLogin 回傳設定，不要求 webhook', async () => {
  const dir = tmp();
  const src = applyAnswersToToml(readFileSync(EXAMPLE, 'utf8'), [
    { header: '[[wallets]]', key: 'name', value: 'real.ai' },
    { header: '[[wallets]]', key: 'address', value: ADDR },
  ]);
  writeFileSync(join(dir, 'config.toml'), src);
  const io = muteIO();
  const cfg = await bootstrap({ root: dir, examplePath: EXAMPLE, skipLogin: true, ...io });
  assert.equal(cfg.wallets[0].name, 'real.ai');
  assert.equal(cfg.discord.webhook, '');
});

test('parseAgentId：agentId 優先，handle 自動加 .ai', () => {
  assert.deepEqual(parseAgentIdJson({ success: true, data: { claimed: true, handle: 'alice', agentId: 'alice.ai' } }), {
    claimed: true,
    name: 'alice.ai',
    handle: 'alice',
    success: true,
    code: undefined,
    message: '',
  });
  assert.equal(parseAgentIdJson({ data: { claimed: true, handle: 'Bob' } }).name, 'bob.ai');
  assert.equal(parseAgentIdJson({ data: { claimed: false, handle: 'alice' } }).name, '');
  assert.equal(normalizeAgentName('Alice'), 'alice.ai');
  assert.equal(normalizeAgentName('alice.ai'), 'alice.ai');
});

test('parseBscAddress：取 chainId 56', () => {
  const j = {
    success: true,
    data: {
      addresses: [
        { binanceChainId: '1', chainName: 'Ethereum', address: ADDR2 },
        { binanceChainId: '56', chainName: 'BSC', address: ADDR },
      ],
    },
  };
  assert.equal(parseBscAddressJson(j), ADDR.toLowerCase());
});

test('自動帶入寫回 toml，CLI 地址與設定檔不一致時以 CLI 為準', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8')
    .replace('mywallet.ai', 'old.ai')
    .replace('0xYourAgentWallet', ADDR2));
  const io = muteIO();
  const baw = mockBaw({ address: ADDR, agentId: 'alice.ai', handle: 'alice' });
  baw.wallet = { name: 'old.ai', address: ADDR2 };
  const got = await fetchAndApplyIdentity({
    baw,
    tomlPath: join(dir, 'config.toml'),
    previous: { name: 'old.ai', address: ADDR2 },
    root: dir,
    interactive: false,
    ...io,
  });
  assert.equal(got.name, 'alice.ai');
  assert.equal(got.address, ADDR.toLowerCase());
  const saved = readFileSync(join(dir, 'config.toml'), 'utf8');
  assert.match(saved, /name = "alice\.ai"/);
  assert.match(saved, new RegExp(ADDR, 'i'));
  assert.match(saved, /# 錢包：至少一個/);
  assert.match(io.output(), /不一致/);
  assert.match(io.output(), /baw/);
});

test('未領 Agent ID 不能帶入、不能假裝就緒', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8'));
  const io = muteIO();
  await assert.rejects(
    () => fetchAndApplyIdentity({
      baw: mockBaw({ claimed: false }),
      tomlPath: join(dir, 'config.toml'),
      root: dir,
      interactive: false,
      ...io,
    }),
    (e) => e instanceof SetupError && /尚未領取 Agent ID/.test(e.message) && /無法打內盤/.test(e.message),
  );
  assert.match(readFileSync(join(dir, 'config.toml'), 'utf8'), /mywallet\.ai/);
});

test('已寫入且與 CLI 一致：不詢問覆寫', () => {
  assert.equal(shouldPromptIdentity({ name: 'alice.ai', address: ADDR }, { name: 'alice.ai', address: ADDR }), false);
  assert.equal(shouldPromptIdentity({ name: 'Alice.AI', address: ADDR.toUpperCase() }, { name: 'alice.ai', address: ADDR }), false);
  assert.equal(shouldPromptIdentity({ name: 'alice.ai', address: ADDR }, { name: 'mywallet.ai', address: '0xYourAgentWallet' }), true);
  assert.equal(shouldPromptIdentity({ name: 'alice.ai', address: ADDR }, { name: 'bob.ai', address: ADDR }), true);
  assert.equal(shouldPromptIdentity({ name: 'alice.ai', address: ADDR }, { name: 'alice.ai', address: ADDR2 }), true);
  assert.equal(shouldPromptIdentity({ name: 'alice.ai', address: ADDR }, { name: 'alice.ai', address: ADDR }, { forceConfirm: true }), true);
});

test('已寫入且與 CLI 一致：互動也不出現覆寫提示', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8')
    .replace('mywallet.ai', 'alice.ai')
    .replace('0xYourAgentWallet', ADDR));
  const io = ttyAsk([]);
  const baw = mockBaw({ address: ADDR, agentId: 'alice.ai', handle: 'alice' });
  baw.wallet = { name: 'alice.ai', address: ADDR };
  const got = await fetchAndApplyIdentity({
    baw,
    tomlPath: join(dir, 'config.toml'),
    previous: { name: 'alice.ai', address: ADDR },
    root: dir,
    interactive: true,
    ...io,
  });
  assert.equal(got.name, 'alice.ai');
  assert.equal(got.address, ADDR.toLowerCase());
  assert.doesNotMatch(io.output(), /手動覆寫/);
  assert.doesNotMatch(io.output(), /直接 Enter 採用/);
  assert.doesNotMatch(io.output(), /已從 baw 帶入錢包身分/);
});

test('CLI 名稱或地址與檔案不一致才問覆寫', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8')
    .replace('mywallet.ai', 'old.ai')
    .replace('0xYourAgentWallet', ADDR2));
  const asked = [];
  const io = ttyAsk(['']);
  const origAsk = io.ask;
  io.ask = async (label) => {
    asked.push(label);
    return origAsk(label);
  };
  const baw = mockBaw({ address: ADDR, agentId: 'alice.ai', handle: 'alice' });
  baw.wallet = { name: 'old.ai', address: ADDR2 };
  const got = await fetchAndApplyIdentity({
    baw,
    tomlPath: join(dir, 'config.toml'),
    previous: { name: 'old.ai', address: ADDR2 },
    root: dir,
    interactive: true,
    ...io,
  });
  assert.equal(got.name, 'alice.ai');
  assert.equal(got.address, ADDR.toLowerCase());
  assert.equal(asked.length, 1);
  assert.match(asked[0], /手動覆寫/);
  assert.match(io.output(), /不一致/);
});

test('選單 7 強制覆寫：即使已一致也詢問', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8')
    .replace('mywallet.ai', 'alice.ai')
    .replace('0xYourAgentWallet', ADDR));
  const asked = [];
  const io = ttyAsk(['']);
  const origAsk = io.ask;
  io.ask = async (label) => {
    asked.push(label);
    return origAsk(label);
  };
  const baw = mockBaw({ address: ADDR, agentId: 'alice.ai', handle: 'alice' });
  baw.wallet = { name: 'alice.ai', address: ADDR };
  await fetchAndApplyIdentity({
    baw,
    tomlPath: join(dir, 'config.toml'),
    previous: { name: 'alice.ai', address: ADDR },
    root: dir,
    interactive: true,
    forceConfirm: true,
    ...io,
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /手動覆寫/);
});

test('TTY bootstrap 已寫入且一致：不出現覆寫提示，選 1 才回傳', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), applyAnswersToToml(readFileSync(EXAMPLE, 'utf8'), [
    { header: '[[wallets]]', key: 'name', value: 'alice.ai' },
    { header: '[[wallets]]', key: 'address', value: ADDR },
  ]));
  const io = ttyAsk(['1']);
  const cfg = await bootstrap({
    root: dir,
    examplePath: EXAMPLE,
    createClient: () => mockBaw({ agentId: 'alice.ai', handle: 'alice', address: ADDR }),
    ...io,
  });
  assert.equal(cfg.wallets[0].name, 'alice.ai');
  assert.doesNotMatch(io.output(), /手動覆寫/);
  assert.doesNotMatch(io.output(), /直接 Enter 採用/);
  assert.match(io.output(), /開始監控/);
});

test('TTY bootstrap：登入後帶入身分，選 1 才回傳，不要求 webhook', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'config.toml'), readFileSync(EXAMPLE, 'utf8'));
  const io = ttyAsk(['', '1']);
  const cfg = await bootstrap({
    root: dir,
    examplePath: EXAMPLE,
    createClient: () => mockBaw({ agentId: 'alice.ai', handle: 'alice', address: ADDR }),
    ...io,
  });
  assert.equal(cfg.wallets[0].name, 'alice.ai');
  assert.equal(cfg.wallets[0].address, ADDR.toLowerCase());
  assert.equal(cfg.discord.webhook, '');
  assert.match(io.output(), /開始監控/);
  assert.match(readFileSync(join(dir, 'config.toml'), 'utf8'), /name = "alice\.ai"/);
});
