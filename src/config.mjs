import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { DEFAULT_RPCS, EXEC_MODES, SOURCE_IDS } from './lib/const.mjs';
import { isAddress, lc } from './lib/util.mjs';
import { isDiscordWebhook } from './notify/discord.mjs';

export const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
export const DATA_DIR = join(ROOT, 'data');
export const CONFIG_TOML = join(ROOT, 'config.toml');
export const CONFIG_JSON = join(ROOT, 'config.json');
export const CONFIG_EXAMPLE_TOML = join(ROOT, 'config.example.toml');

export const EXAMPLE_WALLET_NAME = 'mywallet.ai';
export const EXAMPLE_WALLET_ADDRESS = '0xYourAgentWallet';

const DEFAULTS = {
  timeZone: 'Asia/Taipei',
  discovery: {
    memeRush: { enabled: true, intervalMs: 15_000, cli: '', rankTypes: [10, 20], limit: 50 },
    newContracts: { enabled: true, lookbackBlocks: 64, intervalMs: 3_000, lagJumpBlocks: 1600 },
    heat: { enabled: true, windowMs: 180_000, minWallets: 8, intervalMs: 20_000, lookbackBlocks: 32, lagJumpBlocks: 1600 },
    mintEvents: { enabled: true, windowMs: 900_000, minMints: 8, lookbackBlocks: 60, intervalMs: 0, lagJumpBlocks: 1600 },
  },
  execution: {
    free: 'notify',
    paid: 'auto',
  },
  thresholds: {
    progressPct: 60,
    agentIdWallets: 100,
    requirePerWalletCap: true,
    serialDeployMax: 3,
    serialDevMax: 10,
    freshWalletNonce: 50,
  },
  budget: {
    maxUsdPerProject: 20,
    maxUsdPerDay: 200,
    keepBnb: 0.006,
  },
  sell: {
    backX: 2,
    steps: [[10, 30], [20, 50]],
    crash: 0.4,
    crashAfterBack: 0.6,
    moonPct: 20,
    moonNotifyX: [50, 100],
    notifyX: [5, 10, 20],
    freeDrop: 0.5,
    fastMin: 30,
  },
  official: {
    agentIdScript: '',
    memeRushCli: '',
    slippageBps: 2000,
    buyAmountBnb: '0.05',
  },
  wallets: [],
  telegram: { botToken: '', chatId: '', groupChatId: '' },
  discord: { webhook: '', pass_webhook: '', alert_webhook: '' },
  forceMint: [],
  tokens: [],
  rpcs: [],
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base !== 'object' || base === null) return extra ?? base;
  if (typeof extra !== 'object' || extra === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function assertMode(v, label) {
  if (!EXEC_MODES.includes(v)) throw new Error(`${label} 必須是 notify / confirm / auto，目前是 ${v}`);
  return v;
}

export function isPlaceholderName(name) {
  const n = String(name || '').trim();
  return !n || n === EXAMPLE_WALLET_NAME;
}

export function isPlaceholderAddress(addr) {
  const a = String(addr || '').trim();
  if (!a || /youragentwallet/i.test(a)) return true;
  return !isAddress(a);
}

export function isPlaceholderWebhook(url) {
  const u = String(url || '').trim();
  if (!u || u.includes('...') || /YOUR|changeme|placeholder/i.test(u)) return true;
  return !isDiscordWebhook(u);
}

export function collectMissing(cfg) {
  const missing = [];
  const w = cfg.wallets?.[0];
  if (isPlaceholderName(w?.name)) {
    missing.push({ id: 'wallet.name', header: '[[wallets]]', key: 'name', label: '錢包名稱（Agent ID / .ai）' });
  }
  if (isPlaceholderAddress(w?.address)) {
    missing.push({ id: 'wallet.address', header: '[[wallets]]', key: 'address', label: '錢包地址' });
  }
  return missing;
}

function parseRaw(text, kind) {
  if (kind === 'json') return JSON.parse(text);
  return parseToml(text);
}

export function resolveConfigPath(explicit, { root = ROOT } = {}) {
  if (explicit) {
    const kind = String(explicit).endsWith('.json') ? 'json' : 'toml';
    return { path: explicit, kind, legacy: kind === 'json' };
  }
  const toml = join(root, 'config.toml');
  const json = join(root, 'config.json');
  if (existsSync(toml)) return { path: toml, kind: 'toml', legacy: false };
  if (existsSync(json)) return { path: json, kind: 'json', legacy: true };
  return { path: toml, kind: 'toml', legacy: false, missing: true };
}

function mapWallet(w, i, strict) {
  if (strict && (!w?.name || !isAddress(w.address))) {
    throw new Error(`wallets[${i}] 需要 name 與合法 address`);
  }
  return {
    name: String(w?.name || ''),
    address: w?.address && isAddress(w.address) ? lc(w.address) : String(w?.address || ''),
    bawDir: w?.bawDir || '',
    bawPkg: w?.bawPkg || '',
    instanceId: w?.instanceId || w?.name || '',
  };
}

export function normalizeConfig(raw, { strict = true } = {}) {
  const cfg = deepMerge(DEFAULTS, raw || {});

  if (!Array.isArray(cfg.wallets) || !cfg.wallets.length) {
    if (strict) throw new Error('config.wallets 至少要有一個錢包');
    cfg.wallets = [];
  } else {
    cfg.wallets = cfg.wallets.map((w, i) => mapWallet(w, i, strict));
  }

  cfg.execution.free = assertMode(cfg.execution.free, 'execution.free');
  cfg.execution.paid = assertMode(cfg.execution.paid, 'execution.paid');

  for (const id of SOURCE_IDS.filter((x) => x !== 'forceMint')) {
    if (!cfg.discovery[id]) cfg.discovery[id] = { enabled: false };
    cfg.discovery[id].enabled = !!cfg.discovery[id].enabled;
  }

  cfg.forceMint = (cfg.forceMint || []).map((a) => lc(a)).filter(isAddress);
  cfg.tokens = (cfg.tokens || []).map((t) => ({
    ...t,
    addr: lc(t.addr || t.address || ''),
    cost: Number(t.cost || 0),
    hold: !!t.hold,
    both: !!t.both,
    sellNow: !!t.sellNow,
  })).filter((t) => isAddress(t.addr));
  cfg.rpcs = Array.isArray(cfg.rpcs) && cfg.rpcs.length ? cfg.rpcs : DEFAULT_RPCS;

  cfg.telegram = {
    botToken: cfg.telegram?.botToken || process.env.TG_BOT_TOKEN || '',
    chatId: String(cfg.telegram?.chatId || process.env.TG_CHAT_ID || ''),
    groupChatId: String(cfg.telegram?.groupChatId || ''),
  };
  cfg.discord = {
    webhook: String(cfg.discord?.webhook || process.env.DISCORD_WEBHOOK || ''),
    pass_webhook: String(cfg.discord?.pass_webhook || cfg.discord?.passWebhook || process.env.DISCORD_PASS_WEBHOOK || ''),
    alert_webhook: String(cfg.discord?.alert_webhook || cfg.discord?.alertWebhook || process.env.DISCORD_ALERT_WEBHOOK || ''),
  };
  cfg.official.buyAmountBnb = String(cfg.official.buyAmountBnb ?? '0.05');

  return cfg;
}

export function loadConfig(path, { strict = true, warn = console.warn, root = ROOT } = {}) {
  const resolved = resolveConfigPath(path, { root });
  if (resolved.missing || !existsSync(resolved.path)) {
    throw new Error(`找不到 ${resolved.path}。請執行 npm start 以建立並填寫 config.toml。`);
  }
  if (resolved.legacy) {
    warn('偵測到舊的 config.json，請改用 config.toml。本次先讀入 JSON。');
  }
  const raw = parseRaw(readFileSync(resolved.path, 'utf8'), resolved.kind);
  return normalizeConfig(raw, { strict });
}

export function sourceEnabled(cfg, id) {
  if (id === 'forceMint') return true;
  return !!cfg.discovery?.[id]?.enabled;
}
