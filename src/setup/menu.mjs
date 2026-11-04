/**
 * TTY 啟動選單：改設定立刻寫回 config.toml，選 1 才進入掃描。
 */
import { createInterface } from 'node:readline/promises';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { join } from 'node:path';
import { collectMissing, isPlaceholderAddress, isPlaceholderName, loadConfig, ROOT } from '../config.mjs';
import { EXEC_MODES } from '../lib/const.mjs';
import { isDiscordWebhook, sendDiscordTest } from '../notify/discord.mjs';
import { green, yellow } from './ansi.mjs';
import { UserQuit } from './errors.mjs';
import { isAgentName, shortAddr } from './identity.mjs';
import { writeTomlPatches } from './toml-patch.mjs';

const SUBMENU_INDENT = '  ';

export function execModeLabel(mode) {
  if (mode === 'notify') return '僅通知';
  if (mode === 'confirm') return '等確認再打';
  if (mode === 'auto') return '自動打';
  return String(mode || '');
}

export function formatExecModeMenuItem(cfg) {
  return `2) 執行模式（免費 ${execModeLabel(cfg.execution?.free)} / 付費 ${execModeLabel(cfg.execution?.paid)}）`;
}

export function formatMenuStatus(cfg, stream = defaultStdout, opts) {
  const w = cfg.wallets?.[0] || {};
  const rawName = w.name && !isPlaceholderName(w.name) ? w.name : '未設定';
  const rawAddr = isPlaceholderAddress(w.address) ? '未設定' : shortAddr(w.address);
  const name = rawName === '未設定' ? rawName : yellow(rawName, stream, opts);
  const addr = rawAddr === '未設定' ? rawAddr : yellow(rawAddr, stream, opts);
  const discord = isDiscordWebhook(cfg.discord?.webhook) ? '已設定' : '未設定';
  const free = yellow('免費', stream, opts);
  const paid = yellow('付費', stream, opts);
  const freeMode = yellow(cfg.execution.free, stream, opts);
  const paidMode = yellow(cfg.execution.paid, stream, opts);
  return `錢包 ${name} / ${addr}   ${free}=${freeMode}  ${paid}=${paidMode}   Discord=${discord}`;
}

/** 選單 2：「免費／付費」與模式值上黃；「模式」與提示列維持原色。 */
export function formatExecModeLine(kind, current, stream = defaultStdout, opts) {
  return `${yellow(kind, stream, opts)}模式 目前 ${yellow(current, stream, opts)}`;
}

/** 「請選」後的數字範圍上綠；非 TTY / NO_COLOR 為原字。 */
export function formatSelectPrompt(range, stream = defaultStdout, opts, after = '：') {
  return `請選 ${green(range, stream, opts)}${after}`;
}

const EXEC_MODE_ALIASES = {
  n: 'notify',
  notify: 'notify',
  僅通知: 'notify',
  c: 'confirm',
  confirm: 'confirm',
  等確認: 'confirm',
  等確認再打: 'confirm',
  a: 'auto',
  auto: 'auto',
  自動打: 'auto',
};

export const EXEC_MODE_PROMPT = '[n-僅通知 / c-等確認再打 / a-自動打]  直接 Enter 略過：';

export function parseExecModeInput(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { skip: true };
  const mapped = EXEC_MODE_ALIASES[v.toLowerCase()] || EXEC_MODE_ALIASES[v];
  if (mapped && EXEC_MODES.includes(mapped)) return { value: mapped };
  return { error: '請輸入 n / c / a（或 notify / confirm / auto，或 僅通知／等確認／自動打）' };
}

export function parseSellSteps(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('steps 格式不對');
    return parsed.map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) throw new Error('steps 每段要有倍數與賣出％');
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('steps 必須是數字');
      return [a, b];
    });
  }
  return s.split(/[;|]/).flatMap((chunk) => chunk.split(/\s*,\s*/)).filter(Boolean).map((part) => {
    const [a, b] = part.split(/[:/]/).map((x) => Number(String(x).trim()));
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('steps 例：10:30,20:50');
    return [a, b];
  });
}

function writeLine(stdout, s) {
  stdout.write(s.endsWith('\n') ? s : `${s}\n`);
}

function reload(tomlPath, root, warn) {
  return loadConfig(tomlPath, { strict: true, root, warn });
}

function apply(tomlPath, patches, root, warn) {
  writeTomlPatches(tomlPath, patches);
  return reload(tomlPath, root, warn);
}

function parseNumber(raw, { integer = false, min, max, gt } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('必須是數字');
  if (integer && !Number.isInteger(n)) throw new Error('必須是整數');
  if (min != null && n < min) throw new Error(`必須 ≥ ${min}`);
  if (gt != null && n <= gt) throw new Error(`必須 > ${gt}`);
  if (max != null && n > max) throw new Error(`必須 ≤ ${max}`);
  return n;
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 0x7f ? 2 : 1;
  return w;
}

function padEndWidth(s, width) {
  return `${s}${' '.repeat(Math.max(0, width - displayWidth(s)))}`;
}

function formatYesNo(v) {
  return v ? '是' : '否';
}

function formatOnOff(v) {
  return v ? '開' : '關';
}

export function formatRatioPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  const rounded = Number.isInteger(pct) ? String(pct) : String(Math.round(pct * 1000) / 1000);
  return `${rounded}%`;
}

export function formatSellSteps(steps) {
  return (steps || []).map((p) => `${p[0]}倍賣${p[1]}%`).join('、');
}

function formatNumberList(arr) {
  return (arr || []).join('、');
}

function formatIntPct(v) {
  return `${v}%`;
}

export function parseYesNo(raw) {
  const v = String(raw ?? '').trim();
  const low = v.toLowerCase();
  if (low === 'y' || low === 'yes' || v === '是' || low === 'true') return { value: true };
  if (low === 'n' || low === 'no' || v === '否' || low === 'false') return { value: false };
  return { error: '請輸入 y / n（或 是／否、true／false）' };
}

export function parseEnabled(raw) {
  const v = String(raw ?? '').trim();
  if (/^(開|on|true|1|y|yes|是)$/i.test(v)) return true;
  if (/^(關|off|false|0|n|no|否)$/i.test(v)) return false;
  throw new Error('請輸入 開／關 或 y/n');
}

export function parseRatioPct(raw) {
  const s = String(raw ?? '').trim();
  const hasPct = /%$/.test(s);
  const n = Number(s.replace(/%$/, '').trim());
  if (!Number.isFinite(n) || n < 0) throw new Error('必須是數字');
  if (hasPct || n > 1) {
    if (n > 100) throw new Error('必須 ≤ 100%');
    return n / 100;
  }
  return n;
}

function parseStoredPct(raw) {
  const n = Number(String(raw ?? '').trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) throw new Error('必須是數字');
  if (n < 0 || n > 100) throw new Error('必須是 0–100');
  return n;
}

export function parseNumberList(raw) {
  const parts = String(raw ?? '').split(/[,、;|\s]+/).filter(Boolean).map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) throw new Error('例：50,100');
  return parts;
}

function parseProgressPct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('必須是數字');
  if (n < 0 || n > 100) throw new Error('進度必須是 0–100');
  return n;
}

function parseWalletCount(raw) {
  return parseNumber(raw, { integer: true, min: 1 });
}

function parsePositiveAmount(raw) {
  return parseNumber(raw, { gt: 0 });
}

const THRESHOLD_ITEMS = [
  {
    id: '3-1',
    label: '進度％',
    hint: '（鑄造／銷售進度）',
    explain: '這是鑄造／銷售進度（已售÷上限）。達標且同時達到 Agent ID 錢包數，才依執行模式通知或打。不是錢包餘額、也不是手續費進度。讀不到進度時改只看錢包數。',
    get: (cfg) => cfg.thresholds.progressPct,
    parse: parseProgressPct,
    patch: (value) => ({ header: '[thresholds]', key: 'progressPct', value }),
  },
  {
    id: '3-2',
    label: 'Agent ID 錢包數',
    hint: '（自己付 gas 且持有 .ai）',
    explain: '只算自己送出交易、付過 gas、且持有 .ai 的錢包。空投灌熱度不算。跟進度一起當進場門檻。',
    get: (cfg) => cfg.thresholds.agentIdWallets,
    parse: parseWalletCount,
    patch: (value) => ({ header: '[thresholds]', key: 'agentIdWallets', value }),
  },
  {
    id: '3-3',
    label: '要求每錢包上限',
    hint: '（沒上限就不自動打）',
    explain: '開＝付費合約必須有「每個錢包最多幾份」或「每筆上限」才自動打；沒上限就只通知、不自動打，避免項目方或少數人無限灌。關＝不檢查這項。官方 bonding（Open Four 內建 1% 上限）視為已有上限。',
    get: (cfg) => cfg.thresholds.requirePerWalletCap,
    display: formatYesNo,
    parse: (raw) => {
      const parsed = parseYesNo(raw);
      if (parsed.error) throw new Error(parsed.error);
      return parsed.value;
    },
    patch: (value) => ({ header: '[thresholds]', key: 'requirePerWalletCap', value }),
  },
  {
    id: '3-4',
    label: '每項目上限 U',
    hint: '（同一錢包同一項目）',
    explain: '同一個錢包、同一個項目最多花多少美金（付費鑄造）。',
    get: (cfg) => cfg.budget.maxUsdPerProject,
    parse: parsePositiveAmount,
    patch: (value) => ({ header: '[budget]', key: 'maxUsdPerProject', value }),
  },
  {
    id: '3-5',
    label: '每日上限 U',
    hint: '（同一錢包當日合計）',
    explain: '同一個錢包每天付費鑄造合計最多花多少美金。',
    get: (cfg) => cfg.budget.maxUsdPerDay,
    parse: parsePositiveAmount,
    patch: (value) => ({ header: '[budget]', key: 'maxUsdPerDay', value }),
  },
  {
    id: '3-6',
    label: '保留 gas（BNB）',
    hint: '（留給賣出的 BNB）',
    explain: '每次自動打完後，錢包至少還要留這麼多 BNB 當 gas；不夠就不打，留給之後賣出。',
    get: (cfg) => cfg.budget.keepBnb,
    parse: parsePositiveAmount,
    patch: (value) => ({ header: '[budget]', key: 'keepBnb', value }),
  },
];

const SELL_ITEMS = [
  {
    id: '4-1',
    label: '回本倍數',
    hint: '（到幾倍先賣回成本）',
    get: (cfg) => cfg.sell.backX,
    parse: (raw) => parseNumber(raw, { min: 0 }),
    patch: (value) => ({ header: '[sell]', key: 'backX', value }),
  },
  {
    id: '4-2',
    label: '分批賣出',
    hint: '（到倍數賣出％）',
    explain: '到某個倍數時賣出持倉％，例 10:30 表示 10 倍賣 30%。',
    get: (cfg) => cfg.sell.steps,
    display: formatSellSteps,
    parse: parseSellSteps,
    prompt: '輸入新值，例 10:30,20:50（直接 Enter 略過）',
    patch: (value) => ({ header: '[sell]', key: 'steps', value }),
  },
  {
    id: '4-3',
    label: '回本前回落',
    hint: '（回本前從最高回落多少全賣）',
    get: (cfg) => cfg.sell.crash,
    display: formatRatioPct,
    parse: parseRatioPct,
    prompt: '輸入新值，例 40 或 40%（直接 Enter 略過）',
    patch: (value) => ({ header: '[sell]', key: 'crash', value }),
  },
  {
    id: '4-4',
    label: '回本後回落',
    hint: '（回本後從最高回落多少全賣）',
    get: (cfg) => cfg.sell.crashAfterBack,
    display: formatRatioPct,
    parse: parseRatioPct,
    prompt: '輸入新值，例 60 或 60%（直接 Enter 略過）',
    patch: (value) => ({ header: '[sell]', key: 'crashAfterBack', value }),
  },
  {
    id: '4-5',
    label: '長抱比例',
    hint: '（回本後留下不自動賣的比例）',
    get: (cfg) => cfg.sell.moonPct,
    display: formatIntPct,
    parse: parseStoredPct,
    prompt: '輸入新值，例 20 或 20%（直接 Enter 略過）',
    patch: (value) => ({ header: '[sell]', key: 'moonPct', value }),
  },
  {
    id: '4-6',
    label: '長抱通知倍數',
    hint: '（長抱到這些倍數只通知）',
    get: (cfg) => cfg.sell.moonNotifyX,
    display: formatNumberList,
    parse: parseNumberList,
    prompt: '輸入新值，例 50,100（直接 Enter 略過）',
    patch: (value) => ({ header: '[sell]', key: 'moonNotifyX', value }),
  },
  {
    id: '4-7',
    label: '免費通知倍數',
    hint: '（免費幣到這些倍數只通知）',
    get: (cfg) => cfg.sell.notifyX,
    display: formatNumberList,
    parse: parseNumberList,
    prompt: '輸入新值，例 5,10,20（直接 Enter 略過）',
    patch: (value) => ({ header: '[sell]', key: 'notifyX', value }),
  },
  {
    id: '4-8',
    label: '免費回落賣出',
    hint: '（免費幣從最高回落全賣）',
    get: (cfg) => cfg.sell.freeDrop,
    display: formatRatioPct,
    parse: parseRatioPct,
    prompt: '輸入新值，例 50 或 50%（直接 Enter 略過）',
    patch: (value) => ({ header: '[sell]', key: 'freeDrop', value }),
  },
];

const SOURCE_ITEMS = [
  {
    id: '5-1',
    label: '官方 Open Four',
    hint: '（meme-rush 查 Agent ID 專屬內盤）',
    get: (cfg) => cfg.discovery.memeRush.enabled,
    display: formatOnOff,
    parse: parseEnabled,
    prompt: '輸入 開／關 或 y/n（直接 Enter 略過）',
    patch: (value) => ({ header: '[discovery.memeRush]', key: 'enabled', value }),
  },
  {
    id: '5-2',
    label: '新合約掃描',
    hint: '（鏈上新部署／CREATE2）',
    get: (cfg) => cfg.discovery.newContracts.enabled,
    display: formatOnOff,
    parse: parseEnabled,
    prompt: '輸入 開／關 或 y/n（直接 Enter 略過）',
    patch: (value) => ({ header: '[discovery.newContracts]', key: 'enabled', value }),
  },
  {
    id: '5-3',
    label: '熱度掃描',
    hint: '（短時間很多人在打）',
    get: (cfg) => cfg.discovery.heat.enabled,
    display: formatOnOff,
    parse: parseEnabled,
    prompt: '輸入 開／關 或 y/n（直接 Enter 略過）',
    patch: (value) => ({ header: '[discovery.heat]', key: 'enabled', value }),
  },
  {
    id: '5-4',
    label: '鑄造事件',
    hint: '（15 分鐘累積 Transfer from 0）',
    get: (cfg) => cfg.discovery.mintEvents.enabled,
    display: formatOnOff,
    parse: parseEnabled,
    prompt: '輸入 開／關 或 y/n（直接 Enter 略過）',
    patch: (value) => ({ header: '[discovery.mintEvents]', key: 'enabled', value }),
  },
];

export function parseSubmenuChoice(raw, count, prefix) {
  const v = String(raw ?? '').trim();
  if (!v || v === '0') return { back: true };
  const m = new RegExp(`^(?:${prefix}[-.])?([1-${count}])\\.?$`).exec(v);
  if (m) return { index: Number(m[1]) - 1 };
  return { error: `請輸入 1–${count}（或 ${prefix}-1…），0 回到上層` };
}

export function parseThresholdChoice(raw, count = THRESHOLD_ITEMS.length) {
  return parseSubmenuChoice(raw, count, '3');
}

export function parseSellChoice(raw, count = SELL_ITEMS.length) {
  return parseSubmenuChoice(raw, count, '4');
}

export function parseSourceChoice(raw, count = SOURCE_ITEMS.length) {
  return parseSubmenuChoice(raw, count, '5');
}

function shownItemValue(item, cfg) {
  const cur = item.get(cfg);
  return item.display ? item.display(cur) : cur;
}

export function itemExplain(item) {
  if (item?.explain) return item.explain;
  if (item?.hint) return String(item.hint).replace(/^（|）$/g, '');
  return '';
}

export function formatSubmenuLines(title, items, cfg, stream = defaultStdout, opts) {
  const labelWidth = Math.max(...items.map((it) => displayWidth(it.label)));
  const lines = [title];
  for (const it of items) {
    const hint = it.hint ? `   ${it.hint}` : '';
    lines.push(`${SUBMENU_INDENT}${it.id}. ${padEndWidth(it.label, labelWidth)}  目前 ${yellow(shownItemValue(it, cfg), stream, opts)}${hint}`);
  }
  lines.push(`${SUBMENU_INDENT}0) 回到上層選單`);
  return lines;
}

export function formatThresholdsMenuLines(cfg, stream = defaultStdout, opts) {
  return formatSubmenuLines('門檻與預算', THRESHOLD_ITEMS, cfg, stream, opts);
}

export function formatSellMenuLines(cfg, stream = defaultStdout, opts) {
  return formatSubmenuLines('賣出規則', SELL_ITEMS, cfg, stream, opts);
}

export function formatSourcesMenuLines(cfg, stream = defaultStdout, opts) {
  return formatSubmenuLines('發現來源', SOURCE_ITEMS, cfg, stream, opts);
}

async function askExecMode(ask, write, kind, current, stream, opts) {
  write(formatExecModeLine(kind, current, stream, opts));
  for (;;) {
    const parsed = parseExecModeInput(await ask(EXEC_MODE_PROMPT));
    if (parsed.skip) return null;
    if (parsed.error) {
      write(parsed.error);
      continue;
    }
    return parsed.value;
  }
}

async function editExecution(cfg, { ask, write, tomlPath, root, stdout }) {
  const patches = [];
  const free = await askExecMode(ask, write, '免費', cfg.execution.free, stdout);
  if (free != null) patches.push({ header: '[execution]', key: 'free', value: free });
  const paid = await askExecMode(ask, write, '付費', cfg.execution.paid, stdout);
  if (paid != null) patches.push({ header: '[execution]', key: 'paid', value: paid });
  if (!patches.length) {
    write('未變更。');
    return cfg;
  }
  const next = apply(tomlPath, patches, root, write);
  write(`已寫回：免費=${next.execution.free}  付費=${next.execution.paid}`);
  return next;
}

async function askNewValue(ask, write, label, current, parse, stdout, prompt = '輸入新值（直接 Enter 略過）', explain = '') {
  if (explain) write(explain);
  write(`${label} 目前 ${yellow(current, stdout)}`);
  for (;;) {
    const raw = String(await ask(prompt) || '').trim();
    if (!raw) return { skip: true };
    try {
      return { value: parse(raw) };
    } catch (e) {
      write(e.message || String(e));
    }
  }
}

async function editSubmenu(cfg, { ask, write, tomlPath, root, stdout, title, items, prefix }) {
  let current = cfg;
  for (;;) {
    for (const line of formatSubmenuLines(title, items, current, stdout)) write(line);
    const picked = parseSubmenuChoice(await ask(formatSelectPrompt(`1–${items.length}`, stdout, undefined, '，0 回到上層：')), items.length, prefix);
    if (picked.back) return current;
    if (picked.error) {
      write(picked.error);
      continue;
    }
    const item = items[picked.index];
    const next = await askNewValue(
      ask,
      write,
      item.label,
      shownItemValue(item, current),
      item.parse,
      stdout,
      item.prompt,
      itemExplain(item),
    );
    if (next.skip) continue;
    current = apply(tomlPath, [item.patch(next.value)], root, write);
    write(`已寫回：${item.label} ${shownItemValue(item, current)}`);
  }
}

async function editThresholds(cfg, ctx) {
  return editSubmenu(cfg, { ...ctx, title: '門檻與預算', items: THRESHOLD_ITEMS, prefix: '3' });
}

async function editSell(cfg, ctx) {
  return editSubmenu(cfg, { ...ctx, title: '賣出規則', items: SELL_ITEMS, prefix: '4' });
}

async function editSources(cfg, ctx) {
  return editSubmenu(cfg, { ...ctx, title: '發現來源', items: SOURCE_ITEMS, prefix: '5' });
}

async function editDiscord(cfg, { ask, write, tomlPath, root, fetchImpl }) {
  const current = String(cfg.discord?.webhook || '').trim();
  write(`目前 Discord webhook：${isDiscordWebhook(current) ? '已設定' : '未設定（可略過，通知只寫 log）'}`);
  write('Enter 略過；貼上 URL 寫入；輸入 test 測發送；輸入 clear 清除。');
  const raw = String(await ask('Discord webhook') || '').trim();
  if (!raw) {
    write('已略過。');
    return cfg;
  }
  if (/^test$/i.test(raw)) {
    if (!isDiscordWebhook(current)) {
      write('尚未設定 webhook，無法測發送。');
      return cfg;
    }
    await sendDiscordTest(current, { fetchImpl });
    write('已送出測試通知。');
    return cfg;
  }
  if (/^(clear|刪除|空)$/i.test(raw)) {
    const next = apply(tomlPath, [{ header: '[discord]', key: 'webhook', value: '' }], root, write);
    write('已清除 Discord webhook。通知只寫 log。');
    return next;
  }
  if (!isDiscordWebhook(raw)) {
    throw new Error('必須是 Discord webhook URL（https://discord.com/api/webhooks/...）');
  }
  const next = apply(tomlPath, [{ header: '[discord]', key: 'webhook', value: raw }], root, write);
  write('已寫回 Discord webhook。');
  return next;
}

function printMenu(write, cfg, stdout) {
  write('');
  write(formatMenuStatus(cfg, stdout));
  write('1) 開始監控');
  write(formatExecModeMenuItem(cfg));
  write('3) 門檻與預算（進度％、Agent ID 錢包數、每項目／每日上限、保留 gas）');
  write('4) 賣出規則（回本倍數、分批賣出、回落、長抱）');
  write('5) 發現來源（官方 Open Four、新合約、熱度、鑄造）');
  write('6) Discord webhook（可略過、可測發送，之後會有更多通知方式）');
  write('7) 重新登入 baw／重新讀取錢包');
  write('8) 結束');
}

function canStart(cfg) {
  if (collectMissing(cfg).length) return '錢包名稱或地址尚未就緒，請先選 7 重新讀取。';
  if (!isAgentName(cfg.wallets?.[0]?.name)) {
    return '錢包名稱應是幣安 Agent ID（例如 alice.ai）。沒有 .ai 就無法打內盤。';
  }
  return '';
}

export async function runSetupMenu({
  cfg,
  root = ROOT,
  stdin = defaultStdin,
  stdout = defaultStdout,
  ask,
  reloadIdentity,
  fetchImpl = fetch,
} = {}) {
  const tomlPath = join(root, 'config.toml');
  const write = (s) => writeLine(stdout, s);
  let rl;
  const question = ask || (async (label) => {
    if (!rl) rl = createInterface({ input: stdin, output: stdout });
    const hint = label.endsWith('：') ? label : `${label}：`;
    return (await rl.question(hint)).trim();
  });
  let current = cfg;
  try {
    for (;;) {
      printMenu(write, current, stdout);
      const choice = String(await question(formatSelectPrompt('1–8', stdout)) || '').trim();
      try {
        if (choice === '1') {
          const err = canStart(current);
          if (err) {
            write(err);
            continue;
          }
          write('開始監控。');
          return { action: 'start', cfg: current };
        }
        if (choice === '2') {
          current = await editExecution(current, { ask: question, write, tomlPath, root, stdout });
          continue;
        }
        if (choice === '3') {
          current = await editThresholds(current, { ask: question, write, tomlPath, root, stdout });
          continue;
        }
        if (choice === '4') {
          current = await editSell(current, { ask: question, write, tomlPath, root, stdout });
          continue;
        }
        if (choice === '5') {
          current = await editSources(current, { ask: question, write, tomlPath, root, stdout });
          continue;
        }
        if (choice === '6') {
          current = await editDiscord(current, { ask: question, write, tomlPath, root, fetchImpl });
          continue;
        }
        if (choice === '7') {
          if (!reloadIdentity) {
            write('這個環境不能重新讀取錢包。');
            continue;
          }
          current = await reloadIdentity(current);
          write(formatMenuStatus(current, stdout));
          continue;
        }
        if (choice === '8') {
          throw new UserQuit('已結束。');
        }
        write('請輸入 1–8 的數字。');
      } catch (e) {
        if (e instanceof UserQuit) throw e;
        write(e.message || String(e));
      }
    }
  } finally {
    rl?.close();
  }
}
