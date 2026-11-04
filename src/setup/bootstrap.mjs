/**
 * npm start 啟動前：補齊 config.toml、baw 登入、自動帶入錢包、選單。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { join } from 'node:path';
import {
  CONFIG_EXAMPLE_TOML,
  isPlaceholderName,
  loadConfig,
  ROOT,
} from '../config.mjs';
import { createBawClient } from '../exec/baw.mjs';
import { isAddress } from '../lib/util.mjs';
import { isDiscordWebhook } from '../notify/discord.mjs';
import { green, yellow } from './ansi.mjs';
import { SetupError, UserQuit } from './errors.mjs';
import {
  fetchIdentities,
  isAgentBackendUnavailable,
  isAgentName,
  UNCLAIMED_AGENT_ID_MESSAGE,
} from './identity.mjs';
import { runSetupMenu } from './menu.mjs';
import { appendWalletTable, patchTomlKey } from './toml-patch.mjs';

export { SetupError, UserQuit } from './errors.mjs';

export const DEV_MODE_GUIDE = [
  '請依序操作：',
  '1. 打開幣安 App',
  '2. 進入 Agentic Wallet',
  '3. 打開設定',
  '4. 開啟開發者模式',
  '5. 確認風險提示',
  '6. 回到這裡按 Enter 重新檢查；輸入 結束 可離開',
].join('\n');

export const AGENT_ID_GUIDE = [
  '請依序操作：',
  '1. 打開幣安 App',
  '2. 進入 Web3 錢包',
  '3. 打開 Agent ID',
  '4. 領取 .ai 名稱',
  '5. 回到這裡按 Enter 重新檢查；輸入 結束 可離開',
].join('\n');

export const AGENT_BACKEND_UNAVAILABLE_MESSAGE = 'Agent ID 服務暫時無法使用，請稍後再試。這不代表尚未領取。';

export function formatDevModeLine(tag, enabled) {
  return enabled
    ? `[${tag}] ✅ 開發者模式已開`
    : `[${tag}] ❌ 開發者模式未開`;
}

export function formatAgentIdLine(tag, claimed, extra = '') {
  return claimed
    ? `[${tag}] ✅ Agent ID 已領取（${extra}）`
    : `[${tag}] ❌ Agent ID 未領取`;
}

export function isQuitAnswer(raw) {
  return /^(q|quit|exit|結束|離開)$/i.test(String(raw || '').trim());
}

export function isInteractive(stdin = defaultStdin, stdout = defaultStdout) {
  return !!(stdin?.isTTY && stdout?.isTTY);
}

function walletTag(name) {
  return isPlaceholderName(name) ? '錢包' : name;
}

export function validateAnswer(id, value) {
  if (id === 'wallet.name') return value ? '' : '名稱不能空白';
  if (id === 'wallet.address') {
    return isAddress(value) ? '' : '必須是 0x 開頭的 40 碼十六進位地址';
  }
  if (id === 'discord.webhook') {
    return isDiscordWebhook(value) ? '' : '必須是 Discord webhook URL（https://discord.com/api/webhooks/...）';
  }
  return value ? '' : '不能空白';
}

export async function promptMissing(fields, { stdin = defaultStdin, stdout = defaultStdout, ask } = {}) {
  const write = (s) => { stdout.write(s.endsWith('\n') ? s : `${s}\n`); };
  write('請填寫必要欄位（其他沿用 config.example.toml 預設與註解）。');
  let rl;
  const question = ask || (async (label) => {
    if (!rl) rl = createInterface({ input: stdin, output: stdout });
    return (await rl.question(`${label}：`)).trim();
  });
  try {
    const answers = [];
    for (const f of fields) {
      for (;;) {
        const value = String(await question(f.label) || '').trim();
        const err = validateAnswer(f.id, value);
        if (err) {
          write(err);
          continue;
        }
        answers.push({ ...f, value });
        break;
      }
    }
    return answers;
  } finally {
    rl?.close();
  }
}

export function applyAnswersToToml(text, answers) {
  let out = text;
  for (const a of answers) {
    out = patchTomlKey(out, a.header, a.key, a.value);
  }
  return out;
}

export function applyLegacyJsonToToml(text, raw) {
  let out = text;
  const w0 = raw.wallets?.[0];
  if (w0?.name) out = patchTomlKey(out, '[[wallets]]', 'name', w0.name);
  if (w0?.address) out = patchTomlKey(out, '[[wallets]]', 'address', w0.address);
  if (w0?.bawDir) out = patchTomlKey(out, '[[wallets]]', 'bawDir', w0.bawDir);
  if (w0?.bawPkg) out = patchTomlKey(out, '[[wallets]]', 'bawPkg', w0.bawPkg);
  if (w0?.instanceId) out = patchTomlKey(out, '[[wallets]]', 'instanceId', w0.instanceId);
  for (const w of (raw.wallets || []).slice(1)) {
    out = appendWalletTable(out, w);
  }
  if (raw.telegram?.botToken) out = patchTomlKey(out, '[telegram]', 'botToken', raw.telegram.botToken);
  if (raw.telegram?.chatId) out = patchTomlKey(out, '[telegram]', 'chatId', String(raw.telegram.chatId));
  if (raw.telegram?.groupChatId) out = patchTomlKey(out, '[telegram]', 'groupChatId', String(raw.telegram.groupChatId));
  if (raw.discord?.webhook) out = patchTomlKey(out, '[discord]', 'webhook', raw.discord.webhook);
  if (raw.discord?.pass_webhook || raw.discord?.passWebhook) {
    out = patchTomlKey(out, '[discord]', 'pass_webhook', raw.discord.pass_webhook || raw.discord.passWebhook);
  }
  if (raw.discord?.alert_webhook || raw.discord?.alertWebhook) {
    out = patchTomlKey(out, '[discord]', 'alert_webhook', raw.discord.alert_webhook || raw.discord.alertWebhook);
  }
  if (raw.timeZone) out = patchTomlKey(out, '', 'timeZone', raw.timeZone);
  if (raw.execution?.free) out = patchTomlKey(out, '[execution]', 'free', raw.execution.free);
  if (raw.execution?.paid) out = patchTomlKey(out, '[execution]', 'paid', raw.execution.paid);
  return out;
}

export async function ensureToml({
  root = ROOT,
  stdin = defaultStdin,
  stdout = defaultStdout,
  examplePath = CONFIG_EXAMPLE_TOML,
} = {}) {
  const tomlPath = join(root, 'config.toml');
  const jsonPath = join(root, 'config.json');
  const write = (s) => { stdout.write(s.endsWith('\n') ? s : `${s}\n`); };

  if (!existsSync(tomlPath)) {
    if (!existsSync(examplePath)) {
      throw new SetupError(`找不到範例設定 ${examplePath}`);
    }
    copyFileSync(examplePath, tomlPath);
    write(`已從範例建立 ${tomlPath}`);
    write('錢包名稱與地址會在 baw 登入後自動帶入；Discord webhook 可之後再補。');
    if (existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
        writeFileSync(tomlPath, applyLegacyJsonToToml(readFileSync(tomlPath, 'utf8'), raw));
        write('偵測到舊的 config.json，已把錢包／通知等欄位寫入 config.toml。之後請只改 toml。');
      } catch (e) {
        write(`讀取舊 config.json 失敗（${e.message}），改用範例。`);
      }
    }
  }

  return loadConfig(tomlPath, { strict: false, root, warn: write });
}

export const ensureConfigFile = ensureToml;

export async function runLogin(baw, { stdout = defaultStdout } = {}) {
  const write = (s) => { stdout.write(s.endsWith('\n') ? s : `${s}\n`); };
  const tag = walletTag(baw.wallet.name);
  const si = await baw.signin();
  const d = si.j?.data;
  if (d?.status === 'ALREADY_CONNECTED') {
    write(`[${tag}] 已經登入`);
    return true;
  }
  if (!d?.qrCodeId) {
    write(si.t || '無法取得登入連結');
    return false;
  }
  write(`\n[${tag}] 用手機打開這個連結確認登入：\n${green(d.urlForWeb, stdout)}\n配對碼：${yellow(d.pairingCode, stdout)}\n等待確認中…`);
  const v = await baw.verify(d.qrCodeId);
  const ok = v.j?.data?.status === 'SUCCESS' || v.j?.success;
  if (!ok) {
    write('登入失敗：' + (v.t || '').slice(0, 300));
    return false;
  }
  write('登入成功');
  return true;
}

async function inspectReadiness(baw) {
  const settings = await baw.settings();
  const dev = settings.j?.data?.devMode || {};
  const expired = !!(dev.expiresAt && Number(dev.expiresAt) < Date.now());
  const devOk = !!(dev.enabled && !expired);

  const ag = await baw.agentId();
  if (isAgentBackendUnavailable(ag)) {
    return { devOk, agent: 'unavailable', shown: '', ag };
  }
  if (!ag.j || ag.j.success === false) {
    return { devOk, agent: 'error', shown: '', ag };
  }
  if (!ag.j?.data?.claimed) {
    return { devOk, agent: 'unclaimed', shown: '', ag };
  }
  const shown = ag.j?.data?.agentId || ag.j?.data?.domain || '';
  return { devOk, agent: 'claimed', shown, ag };
}

function readinessTag(baw, shown) {
  if (shown && isAgentName(shown)) return shown;
  return walletTag(baw.wallet?.name);
}

export async function ensureOneWallet(baw, {
  interactive,
  stdout = defaultStdout,
  stdin = defaultStdin,
  ask,
} = {}) {
  const write = (s) => { stdout.write(s.endsWith('\n') ? s : `${s}\n`); };
  let tag = walletTag(baw.wallet.name);
  write(`檢查 [${tag}] 登入狀態…`);
  const st = await baw.status();
  if (st.err && !st.j) {
    throw new SetupError(`無法執行 baw（${st.err.message || st.t}）。請確認已安裝幣安 Agentic Wallet CLI。`);
  }
  const status = st.j?.data?.status || 'UNKNOWN';
  if (status !== 'CONNECTED') {
    if (!interactive) {
      throw new SetupError(`[${tag}] 尚未登入（status=${status}）。請在終端機執行 npm start。`);
    }
    const ok = await runLogin(baw, { stdout });
    if (!ok) throw new SetupError(`[${tag}] 登入失敗，監控尚未啟動。`);
  } else {
    write(`[${tag}] 已登入`);
  }

  let rl;
  const question = async (label) => {
    if (ask) return String(await ask(label) || '').trim();
    if (!rl) rl = createInterface({ input: stdin, output: stdout });
    const hint = label.endsWith('：') ? label : `${label}：`;
    return (await rl.question(hint)).trim();
  };

  try {
    for (;;) {
      const ready = await inspectReadiness(baw);
      tag = readinessTag(baw, ready.shown);
      const paintedTag = isAgentName(tag) ? yellow(tag, stdout) : tag;

      write(formatDevModeLine(paintedTag, ready.devOk));
      if (ready.agent === 'unavailable') {
        write(`[${paintedTag}] ${AGENT_BACKEND_UNAVAILABLE_MESSAGE}`);
      } else if (ready.agent === 'error') {
        throw new SetupError(`無法讀取 Agent ID：${ready.ag.j?.message || ready.ag.t || ''}`.trim());
      } else {
        const shown = ready.shown ? yellow(ready.shown, stdout) : '';
        write(formatAgentIdLine(paintedTag, ready.agent === 'claimed', shown));
      }

      if (ready.devOk && ready.agent === 'claimed') return true;

      if (!interactive) {
        if (!ready.devOk) {
          throw new SetupError(
            `${formatDevModeLine(tag, false)}\n開發者模式未開啟或已過期，不能當成已就緒。\n${DEV_MODE_GUIDE}`,
          );
        }
        if (ready.agent === 'unavailable') {
          throw new SetupError(AGENT_BACKEND_UNAVAILABLE_MESSAGE);
        }
        throw new SetupError(`${formatAgentIdLine(tag, false)}\n${UNCLAIMED_AGENT_ID_MESSAGE}`);
      }

      if (!ready.devOk) write(DEV_MODE_GUIDE);
      if (ready.agent === 'unclaimed') write(AGENT_ID_GUIDE);
      if (ready.agent === 'unavailable') {
        write('這是 CLI 後端暫時不可用，不是尚未領取。請稍後按 Enter 再查，或輸入 結束 離開。');
      }

      const ans = await question('按 Enter 重新檢查，或輸入 結束 離開');
      if (isQuitAnswer(ans)) throw new UserQuit('已結束。');
    }
  } finally {
    rl?.close();
  }
}

export async function ensureWalletsReady(cfg, {
  stdin = defaultStdin,
  stdout = defaultStdout,
  createClient = (w) => createBawClient(w),
  ask,
} = {}) {
  const interactive = isInteractive(stdin, stdout);
  for (const w of cfg.wallets.length ? cfg.wallets : [{ name: '', address: '' }]) {
    await ensureOneWallet(createClient(w), { interactive, stdout, stdin, ask });
  }
}

function makeAsk(stdin, stdout, ask) {
  if (ask) return { question: ask, close: () => {} };
  let rl;
  return {
    question: async (label) => {
      if (!rl) rl = createInterface({ input: stdin, output: stdout });
      const hint = label.endsWith('：') ? label : `${label}：`;
      return (await rl.question(hint)).trim();
    },
    close: () => rl?.close(),
  };
}

export async function bootstrap({
  root = ROOT,
  stdin = defaultStdin,
  stdout = defaultStdout,
  skipLogin = process.env.BAW_SKIP_LOGIN === '1',
  skipMenu = process.env.BAW_SKIP_MENU === '1',
  examplePath = CONFIG_EXAMPLE_TOML,
  createClient = (w) => createBawClient(w),
  ask,
  fetchImpl,
} = {}) {
  let cfg = await ensureToml({ root, stdin, stdout, examplePath });
  if (!cfg.wallets.length) cfg.wallets = [{ name: '', address: '' }];
  if (skipLogin) return cfg;

  const interactive = isInteractive(stdin, stdout);
  const session = interactive ? makeAsk(stdin, stdout, ask) : { question: ask, close: () => {} };
  try {
    await ensureWalletsReady(cfg, { stdin, stdout, createClient, ask: session.question });
    cfg = await fetchIdentities(cfg, {
      root,
      createClient,
      interactive,
      ask: session.question,
      stdout,
    });

    if (!interactive || skipMenu) return cfg;

    const result = await runSetupMenu({
      cfg,
      root,
      stdin,
      stdout,
      ask: session.question,
      fetchImpl,
      reloadIdentity: async (current) => {
        await ensureWalletsReady(current, { stdin, stdout, createClient, ask: session.question });
        return fetchIdentities(current, {
          root,
          createClient,
          interactive: true,
          forceConfirm: true,
          ask: session.question,
          stdout,
        });
      },
    });
    return result.cfg;
  } finally {
    session.close();
  }
}
