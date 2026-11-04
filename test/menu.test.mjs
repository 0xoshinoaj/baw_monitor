import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { loadConfig, ROOT } from '../src/config.mjs';
import { UserQuit } from '../src/setup/errors.mjs';
import {
  formatExecModeLine, formatExecModeMenuItem, formatMenuStatus, formatSelectPrompt,
  formatSellMenuLines, formatSourcesMenuLines, formatThresholdsMenuLines,
  parseExecModeInput, parseSellChoice, parseSellSteps, parseSourceChoice,
  parseThresholdChoice, parseYesNo, runSetupMenu,
} from '../src/setup/menu.mjs';
import { applyAnswersToToml } from '../src/setup/bootstrap.mjs';
import { shortAddr } from '../src/setup/identity.mjs';

const ADDR = '0x1111111111111111111111111111111111111111';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
const EXAMPLE = join(ROOT, 'config.example.toml');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'baw-menu-'));
}

function ttyAsk(lines) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = true;
  stdout.isTTY = true;
  let out = '';
  stdout.on('data', (c) => { out += c; });
  let i = 0;
  const ask = async (label = '') => {
    if (label) stdout.write(label.endsWith('：') || label.endsWith(':') ? `${label}\n` : `${label}：\n`);
    const v = lines[i++];
    if (v == null) throw new Error('提問次數超過準備的答案');
    return v;
  };
  return { stdin, stdout, ask, output: () => out };
}

function seedToml(dir, extra = []) {
  const src = applyAnswersToToml(readFileSync(EXAMPLE, 'utf8'), [
    { header: '[[wallets]]', key: 'name', value: 'alice.ai' },
    { header: '[[wallets]]', key: 'address', value: ADDR },
    ...extra,
  ]);
  writeFileSync(join(dir, 'config.toml'), src);
  return loadConfig(join(dir, 'config.toml'), { root: dir, strict: true });
}

const noColor = { isTTY: false };

function stripAnsi(s) {
  return String(s).replace(/\u001b\[\d+m/g, '');
}

test('shortAddr：0x + 前 4 + ... + 後 4', () => {
  assert.equal(shortAddr('0xaa4d000000000000000000000000000000007597'), '0xaa4d...7597');
  assert.equal(shortAddr(ADDR), '0x1111...1111');
  assert.equal(shortAddr('0xaa4d'), '0xaa4d');
  assert.equal(shortAddr(''), '未設定');
});

test('主選單 2 含僅通知與自動打', () => {
  assert.equal(
    formatExecModeMenuItem({ execution: { free: 'notify', paid: 'auto' } }),
    '2) 執行模式（免費 僅通知 / 付費 自動打）',
  );
  assert.equal(
    formatExecModeMenuItem({ execution: { free: 'confirm', paid: 'notify' } }),
    '2) 執行模式（免費 等確認再打 / 付費 僅通知）',
  );
});

test('選單狀態列含錢包與 Discord', () => {
  const cfg = {
    wallets: [{ name: 'alice.ai', address: ADDR }],
    execution: { free: 'notify', paid: 'auto' },
    discord: { webhook: '' },
  };
  const line = formatMenuStatus(cfg, noColor);
  assert.equal(line, '錢包 alice.ai / 0x1111...1111   免費=notify  付費=auto   Discord=未設定');
  const colored = formatMenuStatus(cfg, { isTTY: true }, { env: {} });
  assert.match(colored, /\u001b\[33malice\.ai\u001b\[0m/);
  assert.match(colored, /\u001b\[33m0x1111\.\.\.1111\u001b\[0m/);
  assert.match(colored, /\u001b\[33m免費\u001b\[0m=\u001b\[33mnotify\u001b\[0m/);
  assert.match(colored, /\u001b\[33m付費\u001b\[0m=\u001b\[33mauto\u001b\[0m/);
});

test('請選範圍：開色含綠色 ANSI、關色仍是純文字', () => {
  const off = formatSelectPrompt('1–8', noColor);
  assert.equal(off, '請選 1–8：');
  assert.doesNotMatch(off, /\u001b\[/);
  const noColorEnv = formatSelectPrompt('1–8', { isTTY: true }, { env: { NO_COLOR: '1' } });
  assert.equal(noColorEnv, '請選 1–8：');
  const on = formatSelectPrompt('1–8', { isTTY: true }, { env: {} });
  assert.match(on, /請選 \u001b\[32m1–8\u001b\[0m：/);
  assert.doesNotMatch(on, /\u001b\[32m請選/);
  const sub = formatSelectPrompt('1–6', { isTTY: true }, { env: {} }, '，0 回到上層：');
  assert.match(sub, /請選 \u001b\[32m1–6\u001b\[0m，0 回到上層：/);
});

test('選 2 執行模式列：開色含 ANSI、關色仍是純文字', () => {
  const off = formatExecModeLine('免費', 'notify', noColor);
  assert.equal(off, '免費模式 目前 notify');
  assert.match(off, /免費模式 目前 notify/);
  const on = formatExecModeLine('免費', 'notify', { isTTY: true }, { env: {} });
  assert.match(on, /\u001b\[33m免費\u001b\[0m/);
  assert.match(on, /\u001b\[33mnotify\u001b\[0m/);
  assert.match(on, /模式 目前 /);
  assert.doesNotMatch(on, /\u001b\[33m模式/);
});

test('執行模式解析：n/c/a、Enter 略過、中文別名、無效', () => {
  assert.deepEqual(parseExecModeInput(''), { skip: true });
  assert.deepEqual(parseExecModeInput('   '), { skip: true });
  assert.deepEqual(parseExecModeInput('n'), { value: 'notify' });
  assert.deepEqual(parseExecModeInput('C'), { value: 'confirm' });
  assert.deepEqual(parseExecModeInput('A'), { value: 'auto' });
  assert.deepEqual(parseExecModeInput('notify'), { value: 'notify' });
  assert.deepEqual(parseExecModeInput('CONFIRM'), { value: 'confirm' });
  assert.deepEqual(parseExecModeInput('auto'), { value: 'auto' });
  assert.deepEqual(parseExecModeInput('僅通知'), { value: 'notify' });
  assert.deepEqual(parseExecModeInput('等確認'), { value: 'confirm' });
  assert.deepEqual(parseExecModeInput('等確認再打'), { value: 'confirm' });
  assert.deepEqual(parseExecModeInput('自動打'), { value: 'auto' });
  assert.match(parseExecModeInput('xyz').error, /請輸入 n \/ c \/ a/);
});

test('parseSellSteps 接受 10:30,20:50', () => {
  assert.deepEqual(parseSellSteps('10:30,20:50'), [[10, 30], [20, 50]]);
  assert.deepEqual(parseSellSteps('[[10, 30], [20, 50]]'), [[10, 30], [20, 50]]);
});

test('選 2 立刻寫回執行模式並顯示新值', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['2', 'confirm', 'notify', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.action, 'start');
  assert.equal(r.cfg.execution.free, 'confirm');
  assert.equal(r.cfg.execution.paid, 'notify');
  const saved = readFileSync(join(dir, 'config.toml'), 'utf8');
  assert.match(saved, /free = "confirm"/);
  assert.match(saved, /paid = "notify"/);
  assert.match(saved, /# 執行模式/);
  assert.match(stripAnsi(io.output()), /免費模式 目前 notify/);
  assert.match(stripAnsi(io.output()), /付費模式 目前 auto/);
  assert.match(io.output(), /已寫回：免費=confirm  付費=notify/);
});

test('選 2 接受 n/c/a，Enter 略過，無效重問', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['2', '', '', '2', 'xyz', 'c', 'a', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.cfg.execution.free, 'confirm');
  assert.equal(r.cfg.execution.paid, 'auto');
  const out = stripAnsi(io.output());
  assert.match(out, /免費模式 目前 notify/);
  assert.match(out, /付費模式 目前 auto/);
  assert.match(out, /未變更/);
  assert.match(out, /請輸入 n \/ c \/ a/);
  assert.match(out, /已寫回：免費=confirm  付費=auto/);
  const saved = readFileSync(join(dir, 'config.toml'), 'utf8');
  assert.match(saved, /free = "confirm"/);
  assert.match(saved, /paid = "auto"/);
});

test('門檻子選單列印含目前值，數值上黃', () => {
  const cfg = {
    thresholds: { progressPct: 60, agentIdWallets: 100, requirePerWalletCap: true },
    budget: { maxUsdPerProject: 20, maxUsdPerDay: 200, keepBnb: 0.006 },
  };
  const off = formatThresholdsMenuLines(cfg, noColor).join('\n');
  assert.match(off, /^門檻與預算$/m);
  assert.match(off, /^ {2}3-1\.\s*進度％\s+目前 60/m);
  assert.match(off, /^ {2}3-2\.\s*Agent ID 錢包數\s+目前 100/m);
  assert.match(off, /^ {2}3-3\.\s*要求每錢包上限\s+目前 是/m);
  assert.match(off, /^ {2}3-4\.\s*每項目上限 U\s+目前 20/m);
  assert.match(off, /^ {2}3-5\.\s*每日上限 U\s+目前 200/m);
  assert.match(off, /^ {2}3-6\.\s*保留 gas（BNB）\s+目前 0\.006/m);
  assert.match(off, /^ {2}0\) 回到上層選單$/m);
  const on = formatThresholdsMenuLines(cfg, { isTTY: true }, { env: {} }).join('\n');
  assert.match(on, /\u001b\[33m60\u001b\[0m/);
  assert.match(on, /\u001b\[33m是\u001b\[0m/);
  assert.match(on, /\u001b\[33m0\.006\u001b\[0m/);
  assert.doesNotMatch(on, /\u001b\[33m進度/);
  assert.doesNotMatch(on, /\u001b\[33m目前/);
});

test('門檻子選單選擇：1／3-1、0／空白回上層、無效', () => {
  assert.deepEqual(parseThresholdChoice('1'), { index: 0 });
  assert.deepEqual(parseThresholdChoice('3-1'), { index: 0 });
  assert.deepEqual(parseThresholdChoice('3.6'), { index: 5 });
  assert.deepEqual(parseThresholdChoice('0'), { back: true });
  assert.deepEqual(parseThresholdChoice(''), { back: true });
  assert.deepEqual(parseThresholdChoice('   '), { back: true });
  assert.match(parseThresholdChoice('9').error, /請輸入 1–6/);
  assert.match(parseThresholdChoice('xyz').error, /請輸入 1–6/);
});

test('每錢包上限布林：y/n、是/否、true/false', () => {
  assert.deepEqual(parseYesNo('y'), { value: true });
  assert.deepEqual(parseYesNo('YES'), { value: true });
  assert.deepEqual(parseYesNo('是'), { value: true });
  assert.deepEqual(parseYesNo('true'), { value: true });
  assert.deepEqual(parseYesNo('n'), { value: false });
  assert.deepEqual(parseYesNo('否'), { value: false });
  assert.deepEqual(parseYesNo('FALSE'), { value: false });
  assert.match(parseYesNo('maybe').error, /請輸入 y \/ n/);
});

test('選 3 子選單列印含目前值', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const out = stripAnsi(io.output());
  assert.match(out, /門檻與預算/);
  assert.match(out, /^ {2}3-1\.\s*進度％\s+目前 60/m);
  assert.match(out, /^ {2}3-2\.\s*Agent ID 錢包數\s+目前 100/m);
  assert.match(out, /^ {2}3-3\.\s*要求每錢包上限\s+目前 是/m);
  assert.match(out, /^ {2}3-4\.\s*每項目上限 U\s+目前 20/m);
  assert.match(out, /^ {2}3-5\.\s*每日上限 U\s+目前 200/m);
  assert.match(out, /^ {2}3-6\.\s*保留 gas（BNB）\s+目前 0\.006/m);
  assert.match(out, /^ {2}0\) 回到上層選單$/m);
  assert.match(out, /2\) 執行模式（免費 僅通知 \/ 付費 自動打）/);
});

test('選 3-1 編輯畫面說明鑄造／銷售進度', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '1', '', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const out = stripAnsi(io.output());
  assert.match(out, /鑄造|已售/);
  assert.match(out, /已售÷上限|鑄造／銷售進度/);
});

test('選 3-3 編輯畫面說明每錢包上限', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '3', '', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const out = stripAnsi(io.output());
  assert.match(out, /每錢包|每筆上限/);
  assert.match(out, /不自動打|只通知/);
});

test('主選單與子選單印出請選範圍', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const out = stripAnsi(io.output());
  assert.match(out, /請選 1–8/);
  assert.match(out, /請選 1–6，0 回到上層/);
});

test('選 3 改進度％後回到子選單且值更新', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '1', '70', '0', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.action, 'start');
  assert.equal(r.cfg.thresholds.progressPct, 70);
  const saved = readFileSync(join(dir, 'config.toml'), 'utf8');
  assert.match(saved, /progressPct = 70/);
  const shown = [...stripAnsi(io.output()).matchAll(/3-1\.\s*進度％\s+目前 (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(shown, ['60', '70']);
});

test('選 3 回到上層回主選單，不進掃描', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const out = stripAnsi(io.output());
  assert.match(out, /門檻與預算/);
  assert.match(out, /1\) 開始監控/);
  assert.doesNotMatch(out, /開始監控。/);
});

test('選 3 Enter 略過不寫檔', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const before = readFileSync(join(dir, 'config.toml'), 'utf8');
  const io = ttyAsk(['3', '1', '', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  assert.equal(readFileSync(join(dir, 'config.toml'), 'utf8'), before);
  assert.equal(cfg.thresholds.progressPct, 60);
});

test('選 3 寫回門檻與預算', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '1', '70', '2', '80', '3', 'n', '4', '15', '5', '100', '6', '0.01', '0', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.cfg.thresholds.progressPct, 70);
  assert.equal(r.cfg.thresholds.agentIdWallets, 80);
  assert.equal(r.cfg.thresholds.requirePerWalletCap, false);
  assert.equal(r.cfg.budget.maxUsdPerProject, 15);
  assert.equal(r.cfg.budget.maxUsdPerDay, 100);
  assert.equal(r.cfg.budget.keepBnb, 0.01);
  const saved = readFileSync(join(dir, 'config.toml'), 'utf8');
  assert.match(saved, /progressPct = 70/);
  assert.match(saved, /requirePerWalletCap = false/);
  assert.match(saved, /keepBnb = 0\.01/);
});

test('選 3 無效輸入重問，不默默略過', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['3', '1', 'abc', '200', '70', '0', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.cfg.thresholds.progressPct, 70);
  const out = stripAnsi(io.output());
  assert.match(out, /必須是數字/);
  assert.match(out, /進度必須是 0–100/);
});

test('賣出子選單列印含目前值與前導空白', () => {
  const cfg = {
    sell: {
      backX: 2,
      steps: [[10, 30], [20, 50]],
      crash: 0.4,
      crashAfterBack: 0.6,
      moonPct: 20,
      moonNotifyX: [50, 100],
      notifyX: [5, 10, 20],
      freeDrop: 0.5,
    },
  };
  const off = formatSellMenuLines(cfg, noColor).join('\n');
  assert.match(off, /^賣出規則$/m);
  assert.match(off, /^ {2}4-1\.\s*回本倍數\s+目前 2\s+（到幾倍先賣回成本）/m);
  assert.match(off, /^ {2}4-2\.\s*分批賣出\s+目前 10倍賣30%、20倍賣50%/m);
  assert.match(off, /^ {2}4-3\.\s*回本前回落\s+目前 40%\s+（回本前從最高回落多少全賣）/m);
  assert.match(off, /^ {2}4-4\.\s*回本後回落\s+目前 60%/m);
  assert.match(off, /^ {2}4-5\.\s*長抱比例\s+目前 20%\s+（回本後留下不自動賣的比例）/m);
  assert.match(off, /^ {2}4-6\.\s*長抱通知倍數\s+目前 50、100/m);
  assert.match(off, /^ {2}4-7\.\s*免費通知倍數\s+目前 5、10、20/m);
  assert.match(off, /^ {2}4-8\.\s*免費回落賣出\s+目前 50%/m);
  assert.match(off, /^ {2}0\) 回到上層選單$/m);
  const on = formatSellMenuLines(cfg, { isTTY: true }, { env: {} }).join('\n');
  assert.match(on, /\u001b\[33m2\u001b\[0m/);
  assert.match(on, /\u001b\[33m40%\u001b\[0m/);
  assert.doesNotMatch(on, /\u001b\[33m回本倍數/);
});

test('賣出子選單選擇：1／4-1、0／空白回上層', () => {
  assert.deepEqual(parseSellChoice('1'), { index: 0 });
  assert.deepEqual(parseSellChoice('4-8'), { index: 7 });
  assert.deepEqual(parseSellChoice('0'), { back: true });
  assert.deepEqual(parseSellChoice(''), { back: true });
  assert.match(parseSellChoice('9').error, /請輸入 1–8/);
});

test('選 4-1 與 5-1 編輯畫面再印說明', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['4', '1', '', '0', '5', '1', '', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const out = stripAnsi(io.output());
  assert.match(out, /到幾倍先賣回成本/);
  assert.match(out, /meme-rush 查 Agent ID 專屬內盤/);
});

test('選 4 改一項回到子選單，0 回上層', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['4', '1', '3', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const shown = [...stripAnsi(io.output()).matchAll(/4-1\.\s*回本倍數\s+目前 (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(shown, ['2', '3']);
  const out = stripAnsi(io.output());
  assert.match(out, /賣出規則/);
  assert.match(out, /1\) 開始監控/);
  assert.doesNotMatch(out, /開始監控。/);
  assert.equal(loadConfig(join(dir, 'config.toml'), { root: dir, strict: true }).sell.backX, 3);
  assert.equal(loadConfig(join(dir, 'config.toml'), { root: dir, strict: true }).sell.fastMin, 30);
});

test('選 4 寫回賣出規則', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['4', '1', '3', '2', '10:40,20:60', '3', '30', '5', '25', '0', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.cfg.sell.backX, 3);
  assert.deepEqual(r.cfg.sell.steps, [[10, 40], [20, 60]]);
  assert.equal(r.cfg.sell.crash, 0.3);
  assert.equal(r.cfg.sell.moonPct, 25);
  assert.equal(r.cfg.sell.crashAfterBack, 0.6);
  assert.equal(r.cfg.sell.fastMin, 30);
  assert.match(readFileSync(join(dir, 'config.toml'), 'utf8'), /backX = 3/);
});

test('發現來源子選單列印含目前值與前導空白', () => {
  const cfg = {
    discovery: {
      memeRush: { enabled: true },
      newContracts: { enabled: true },
      heat: { enabled: true },
      mintEvents: { enabled: true },
    },
  };
  const off = formatSourcesMenuLines(cfg, noColor).join('\n');
  assert.match(off, /^發現來源$/m);
  assert.match(off, /^ {2}5-1\.\s*官方 Open Four\s+目前 開\s+（meme-rush 查 Agent ID 專屬內盤）/m);
  assert.match(off, /^ {2}5-2\.\s*新合約掃描\s+目前 開\s+（鏈上新部署／CREATE2）/m);
  assert.match(off, /^ {2}5-3\.\s*熱度掃描\s+目前 開\s+（短時間很多人在打）/m);
  assert.match(off, /^ {2}5-4\.\s*鑄造事件\s+目前 開\s+（15 分鐘累積 Transfer from 0）/m);
  assert.match(off, /^ {2}0\) 回到上層選單$/m);
});

test('發現來源子選單選擇：1／5-1、0 回上層', () => {
  assert.deepEqual(parseSourceChoice('1'), { index: 0 });
  assert.deepEqual(parseSourceChoice('5-4'), { index: 3 });
  assert.deepEqual(parseSourceChoice('0'), { back: true });
  assert.match(parseSourceChoice('9').error, /請輸入 1–4/);
});

test('選 5 改一項回到子選單，0 回上層', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['5', '1', '關', '0', '8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
  const shown = [...stripAnsi(io.output()).matchAll(/5-1\.\s*官方 Open Four\s+目前 (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(shown, ['開', '關']);
  const out = stripAnsi(io.output());
  assert.match(out, /發現來源/);
  assert.match(out, /1\) 開始監控/);
  assert.doesNotMatch(out, /開始監控。/);
});

test('選 5 寫回發現來源開關', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['5', '1', '關', '4', 'n', '0', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.cfg.discovery.memeRush.enabled, false);
  assert.equal(r.cfg.discovery.newContracts.enabled, true);
  assert.equal(r.cfg.discovery.heat.enabled, true);
  assert.equal(r.cfg.discovery.mintEvents.enabled, false);
});

test('選 6 空輸入略過 webhook', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['6', '', '1']);
  const r = await runSetupMenu({ cfg, root: dir, ...io });
  assert.equal(r.cfg.discord.webhook, '');
  assert.match(io.output(), /已略過/);
});

test('選 6 可寫入 webhook 並測發送', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const posts = [];
  const fetchImpl = async (url, opt) => {
    posts.push({ url, body: JSON.parse(opt.body) });
    return { ok: true, text: async () => '' };
  };
  const io = ttyAsk(['6', HOOK, '6', 'test', '1']);
  const r = await runSetupMenu({ cfg, root: dir, fetchImpl, ...io });
  assert.equal(r.cfg.discord.webhook, HOOK);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.content, /測試通知/);
});

test('選 7 重跑身分帶入', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  let called = 0;
  const io = ttyAsk(['7', '1']);
  const r = await runSetupMenu({
    cfg,
    root: dir,
    ...io,
    reloadIdentity: async (current) => {
      called++;
      current.wallets[0].name = 'bob.ai';
      return current;
    },
  });
  assert.equal(called, 1);
  assert.equal(r.cfg.wallets[0].name, 'bob.ai');
});

test('選 8 結束不進掃描', async () => {
  const dir = tmp();
  const cfg = seedToml(dir);
  const io = ttyAsk(['8']);
  await assert.rejects(
    () => runSetupMenu({ cfg, root: dir, ...io }),
    (e) => e instanceof UserQuit && e.exitCode === 0,
  );
});
