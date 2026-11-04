/**
 * 從官方 baw CLI 帶入錢包名稱（Agent ID / .ai）與 BSC 地址。
 */
import { join } from 'node:path';
import { collectMissing, isPlaceholderAddress, isPlaceholderName, loadConfig, ROOT } from '../config.mjs';
import { BINANCE_CHAIN_ID } from '../lib/const.mjs';
import { isAddress, lc } from '../lib/util.mjs';
import { yellow } from './ansi.mjs';
import { SetupError } from './errors.mjs';
import { writeTomlPatches } from './toml-patch.mjs';

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*\.ai$/i;
export const AGENT_BACKEND_UNAVAILABLE = '20003008';

export function isAgentName(name) {
  return AGENT_NAME_RE.test(String(name || '').trim());
}

export function normalizeAgentName(raw) {
  let n = String(raw || '').trim();
  if (!n) return '';
  if (!/\.ai$/i.test(n)) n = `${n}.ai`;
  return n.toLowerCase();
}

export function shortAddr(addr) {
  const a = String(addr || '');
  if (!isAddress(a)) return a || '未設定';
  return `0x${a.slice(2, 6)}...${a.slice(-4)}`;
}

export function isAgentBackendUnavailable(payload) {
  const j = payload?.j && typeof payload.j === 'object' ? payload.j : payload;
  const code = String(j?.code ?? j?.errorCode ?? j?.data?.code ?? '');
  return code === AGENT_BACKEND_UNAVAILABLE;
}

export function parseAgentIdJson(j) {
  const d = j?.data && typeof j.data === 'object' ? j.data : {};
  const claimed = d.claimed === true;
  const raw = String(d.agentId || d.domain || d.handle || '').trim();
  const name = claimed ? normalizeAgentName(raw) : '';
  return {
    claimed,
    name,
    handle: String(d.handle || raw.replace(/\.ai$/i, '') || ''),
    success: j?.success !== false,
    code: j?.code ?? j?.errorCode ?? d?.code,
    message: j?.message || j?.msg || '',
  };
}

function isBscEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const id = entry.binanceChainId ?? entry.chainId ?? entry.chain ?? entry.networkId;
  if (String(id) === String(BINANCE_CHAIN_ID) || Number(id) === Number(BINANCE_CHAIN_ID)) return true;
  return String(entry.chainName || '').toUpperCase() === 'BSC';
}

function pickAddress(entry) {
  const addr = entry?.address || entry?.walletAddress || entry?.addr;
  return isAddress(addr) ? lc(addr) : '';
}

export function parseBscAddressJson(j) {
  const d = j?.data;
  const lists = [];
  if (Array.isArray(d)) lists.push(d);
  if (d && typeof d === 'object') {
    for (const key of ['addresses', 'wallets', 'list', 'chains']) {
      if (Array.isArray(d[key])) lists.push(d[key]);
    }
  }
  for (const list of lists) {
    const hit = list.find(isBscEntry);
    const addr = pickAddress(hit);
    if (addr) return addr;
  }
  if (d && typeof d === 'object') {
    const single = d.address || d.bscAddress || d.bsc;
    if (isAddress(single)) return lc(single);
  }
  return '';
}

function cliFailMessage(kind, r) {
  const j = r?.j;
  if (kind === 'agent-id' && isAgentBackendUnavailable(j || r)) {
    return 'Agent ID 服務暫時無法使用，請稍後再試。這不代表尚未領取。';
  }
  const detail = j?.message || j?.msg || String(r?.t || '').slice(0, 240);
  return `無法讀取 ${kind}${detail ? `：${detail}` : '（baw 無回應）'}`;
}

export const UNCLAIMED_AGENT_ID_MESSAGE = [
  '尚未領取 Agent ID。',
  'Agent ID 是幣安 App（Web3 錢包 → Agent ID）裡領的 .ai 網域，例如 alice.ai。',
  '沒有它就無法打內盤，監控不會啟動。',
  '請到 App 領取後再執行 npm start（或選單「重新登入／重新讀取錢包」）。',
].join('\n');

export async function readIdentityFromBaw(baw) {
  const ag = await baw.agentId();
  if (!ag.j || ag.j.success === false) {
    throw new SetupError(cliFailMessage('Agent ID', ag));
  }
  const parsed = parseAgentIdJson(ag.j);
  if (!parsed.claimed) {
    throw new SetupError(UNCLAIMED_AGENT_ID_MESSAGE);
  }
  if (!isAgentName(parsed.name)) {
    throw new SetupError('baw 回傳的 Agent ID 不是合法的 .ai 名稱，無法當成已就緒。');
  }

  const addrRes = await baw.address();
  if (!addrRes.j || addrRes.j.success === false) {
    throw new SetupError(cliFailMessage('錢包地址', addrRes));
  }
  const address = parseBscAddressJson(addrRes.j);
  if (!isAddress(address)) {
    throw new SetupError('baw 沒有回傳合法的 BSC（chainId 56）地址，無法當成已就緒。');
  }
  return { name: parsed.name, address, handle: parsed.handle };
}

export function fileIdentity(previous) {
  const name = previous?.name && !isPlaceholderName(previous.name)
    ? normalizeAgentName(previous.name)
    : '';
  const address = previous?.address && isAddress(previous.address) && !isPlaceholderAddress(previous.address)
    ? lc(previous.address)
    : '';
  return { name, address, ready: !!(name && address) };
}

export function identityMatchesFile(cli, previous) {
  const file = fileIdentity(previous);
  if (!file.ready) return false;
  return file.name === normalizeAgentName(cli?.name) && file.address === lc(cli?.address);
}

/** 第一次寫入、與 CLI 不一致、或選單 7 主動覆寫時才詢問。 */
export function shouldPromptIdentity(cli, previous, { forceConfirm = false } = {}) {
  if (forceConfirm) return true;
  return !identityMatchesFile(cli, previous);
}

async function confirmIdentity({
  name,
  address,
  previous,
  interactive,
  forceConfirm = false,
  ask,
  write,
  stdout,
}) {
  let nextName = name;
  let nextAddress = address;
  const file = fileIdentity(previous);
  const addrConflict = !!(file.address && file.address !== address);
  const nameConflict = !!(file.name && file.name !== name);
  const conflict = addrConflict || nameConflict;

  if (!shouldPromptIdentity({ name, address }, previous, { forceConfirm })) {
    return { name: nextName, address: nextAddress };
  }

  write('已從 baw 帶入錢包身分：');
  write(`  名稱（Agent ID / .ai）：${yellow(name, stdout)}`);
  write(`  BSC 地址：${yellow(address, stdout)}`);
  write('這是幣安 App 裡領的 .ai 網域：顯示／通知會用它，少數鑄造函式也要用這個名稱算出 tokenId。');
  if (nameConflict) {
    write(`注意：設定檔名稱 ${previous.name} 與 baw 回傳不一致，預設以 baw 為準。`);
  }
  if (addrConflict) {
    write(`注意：設定檔地址 ${previous.address} 與 baw 回傳不一致，預設以 baw 為準。`);
  }

  if (!interactive || !ask) {
    if (conflict) write(`已改用 baw 地址 ${address}`);
    return { name: nextName, address: nextAddress };
  }

  const hint = addrConflict
    ? '直接 Enter 採用 baw；輸入 2 改用設定檔地址；輸入 y 手動覆寫'
    : '直接 Enter 採用；輸入 y 手動覆寫';
  const ans = String(await ask(hint) || '').trim();
  if (addrConflict && ans === '2') {
    nextAddress = file.address;
    write(`已改用設定檔地址 ${nextAddress}`);
    return { name: nextName, address: nextAddress };
  }
  if (!/^y(?:es)?$/i.test(ans)) {
    return { name: nextName, address: nextAddress };
  }

  for (;;) {
    const rawName = String(await ask(`名稱 [${nextName}]`) || '').trim();
    const chosenName = rawName ? normalizeAgentName(rawName) : nextName;
    if (isAgentName(chosenName)) {
      nextName = chosenName;
      break;
    }
    write('名稱應像 alice.ai（幣安 Agent ID）。若 CLI 只回 handle 會自動加 .ai');
  }
  for (;;) {
    const rawAddr = String(await ask(`地址 [${nextAddress}]`) || '').trim();
    const chosenAddr = rawAddr || nextAddress;
    if (isAddress(chosenAddr)) {
      nextAddress = lc(chosenAddr);
      break;
    }
    write('必須是 0x 開頭的 40 碼十六進位地址');
  }
  return { name: nextName, address: nextAddress };
}

export async function fetchAndApplyIdentity({
  baw,
  tomlPath,
  walletIndex = 0,
  previous,
  root = ROOT,
  interactive = false,
  forceConfirm = false,
  ask,
  stdout,
} = {}) {
  const write = (s) => { stdout?.write(s.endsWith('\n') ? s : `${s}\n`); };
  const id = await readIdentityFromBaw(baw);
  const chosen = await confirmIdentity({
    name: id.name,
    address: id.address,
    previous: previous || baw.wallet,
    interactive,
    forceConfirm,
    ask,
    write,
    stdout,
  });

  writeTomlPatches(tomlPath, [
    { header: '[[wallets]]', key: 'name', value: chosen.name, index: walletIndex },
    { header: '[[wallets]]', key: 'address', value: chosen.address, index: walletIndex },
  ]);

  if (baw.wallet) {
    baw.wallet.name = chosen.name;
    baw.wallet.address = chosen.address;
  }
  write(`已寫回 config.toml：${yellow(chosen.name, stdout)} / ${yellow(chosen.address, stdout)}`);
  const cfg = loadConfig(tomlPath, { strict: true, root, warn: write });
  const missing = collectMissing(cfg);
  if (missing.length) {
    throw new SetupError(`自動帶入後仍缺：${missing.map((m) => m.label).join('、')}`);
  }
  return { ...chosen, cfg };
}

export async function fetchIdentities(cfg, {
  root = ROOT,
  createClient,
  interactive = false,
  forceConfirm = false,
  ask,
  stdout,
} = {}) {
  const tomlPath = join(root, 'config.toml');
  let next = cfg;
  for (let i = 0; i < cfg.wallets.length; i++) {
    const baw = createClient(cfg.wallets[i]);
    const got = await fetchAndApplyIdentity({
      baw,
      tomlPath,
      walletIndex: i,
      previous: cfg.wallets[i],
      root,
      interactive,
      forceConfirm,
      ask,
      stdout,
    });
    next = got.cfg;
  }
  return next;
}
