import { EVENT_TYPES } from '../lib/const.mjs';
import { formatProjectRef } from '../project/registry.mjs';

export const BSCSCAN_ADDRESS = 'https://bscscan.com/address/';

/** 結構化事件，不用 emoji 正則分流。 */
export function event(type, { title, lines = [], address, channel = 'dm', silent = false, extra = {} } = {}) {
  return { type, title, lines, address, channel, silent, extra, at: Date.now() };
}

export function formatDiscoveredTitle(project) {
  return `發現候選 ${formatProjectRef(project)}`;
}

export function formatBlockedTitle(project, _reason) {
  return `阻擋 ${formatProjectRef(project)}`;
}

export function formatBscscanLink(address) {
  const a = String(address || '').trim();
  if (!a) return '';
  return `[${a}](${BSCSCAN_ADDRESS}${a})`;
}

export function linesMentionAddress(lines, address) {
  const a = String(address || '').toLowerCase();
  if (!a) return false;
  return (lines || []).some((l) => String(l).toLowerCase().includes(a));
}

export function formatNotifyAmount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  const r = Math.round(x * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

function fmtPct(n) {
  const t = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

function reasonsOf(decision) {
  return Array.isArray(decision?.reasons) ? decision.reasons : [];
}

function hasReason(reasons, pred) {
  return reasons.some((r) => pred(String(r || '')));
}

export function formatWalletLine(wallets = []) {
  const parts = (wallets || []).map((w) => {
    const name = String(w?.name || '').trim();
    const addr = String(w?.address || '').trim();
    if (name && addr) return `${name}(${formatBscscanLink(addr)})`;
    return name || (addr ? formatBscscanLink(addr) : '');
  }).filter(Boolean);
  return `錢包：${parts.join('、') || '未設定'}`;
}

const PASS_NOTIFY_TYPES = new Set([
  EVENT_TYPES.PROJECT_ELIGIBLE,
  EVENT_TYPES.MINT_PENDING_CONFIRM,
  EVENT_TYPES.MINT_PREVIEW,
  EVENT_TYPES.MINT_EXECUTED,
  EVENT_TYPES.MINT_FAILED,
  EVENT_TYPES.POSITION_OPEN,
  EVENT_TYPES.POSITION_MULTIPLE,
  EVENT_TYPES.SELL_EXECUTED,
  EVENT_TYPES.SELL_FAILED,
]);

/** 達門檻／鑄造／開池／倍數／賣出：走 Discord 通過頻道。 */
export function isPassNotifyType(type) {
  return PASS_NOTIFY_TYPES.has(type);
}

function passNotifyConfigured(cfg) {
  const u = String(cfg?.discord?.pass_webhook || cfg?.discord?.passWebhook || '').trim();
  return u.length > 0;
}

export function formatStartupLines(cfg) {
  const t = cfg?.thresholds || {};
  const b = cfg?.budget || {};
  const e = cfg?.execution || {};
  return [
    `執行模式：免費=${e.free} 付費=${e.paid}`,
    formatWalletLine(cfg?.wallets),
    `發現來源：鑄造進度 ${t.progressPct}%、.ai錢包 ${t.agentIdWallets}、日額 ${formatNotifyAmount(b.maxUsdPerDay)}U、免費 ${e.free}／付費 ${e.paid}`,
    `通過通知：${passNotifyConfigured(cfg) ? '已設定' : '未設定'}`,
  ];
}

function formatSpendLine(cfg, risk, extra, reasons) {
  const walletName = extra.walletName || '';
  const spent = Number(risk?.spendUsd?.[walletName] || 0);
  const cap = Number(cfg?.budget?.maxUsdPerDay);
  const over = hasReason(reasons, (r) => r.includes('每日上限')) || (Number.isFinite(cap) && spent >= cap);
  return `本日已花費 ${formatNotifyAmount(spent)}/${formatNotifyAmount(cap)} U${over ? ' ❌' : ''}`;
}

/** 策略擋住的 Discord／事件內文：短句 + 實際/門檻 + ❌，地址連 BSCScan。 */
export function formatBlockedLines(project, cfg, risk = {}, extra = {}) {
  const reasons = reasonsOf(extra.decision);
  const lines = [];
  const needPct = Number(cfg?.thresholds?.progressPct);
  const needWallets = Number(cfg?.thresholds?.agentIdWallets);
  const wallets = Number(project?.heat?.agentIdWallets || 0);
  const readable = !!(project?.progress?.reliable && project.progress.pct != null);

  if (hasReason(reasons, (r) => r.includes('進度讀不到') || r.includes('改看熱度'))) {
    lines.push('進度條無法讀取，改確認錢包熱度');
  } else if (hasReason(reasons, (r) => /鑄造進度/.test(r) && r.includes('未達'))) {
    const pct = readable ? project.progress.pct : NaN;
    lines.push(`鑄造進度 ${Number.isFinite(pct) ? fmtPct(pct) : '?'}% / ${needPct}% ❌`);
  }

  if (hasReason(reasons, (r) => /錢包數/.test(r) && r.includes('未達'))) {
    lines.push(`.ai錢包數 ${wallets}/${needWallets} ❌`);
  }

  const hard = [
    ['連續／批量同 bytecode 部署', '連續／批量同 bytecode 部署 ❌'],
    ['合約資金疑似被抽光', '合約資金疑似被抽光 ❌'],
    ['部署者或合約在黑名單', '部署者或合約在黑名單 ❌'],
    ['付費合約沒有每錢包／每筆上限', '付費合約沒有每錢包／每筆上限 ❌'],
    ['每項目上限', '每項目上限 ≤ 0 ❌'],
  ];
  for (const [needle, line] of hard) {
    if (hasReason(reasons, (r) => r.includes(needle))) lines.push(line);
  }

  const addr = project?.address || extra.address || '';
  if (addr) lines.push(formatBscscanLink(addr));
  lines.push(formatSpendLine(cfg, risk, extra, reasons));
  return lines;
}

export function formatEvent(ev) {
  const body = [ev.title, ...(ev.lines || [])].filter(Boolean).join('\n');
  return body;
}

export function routeEvent(ev) {
  const groupTypes = new Set([
    EVENT_TYPES.PROJECT_DISCOVERED,
    EVENT_TYPES.PROJECT_ELIGIBLE,
    EVENT_TYPES.MINT_EXECUTED,
    EVENT_TYPES.POSITION_OPEN,
    EVENT_TYPES.POSITION_MULTIPLE,
    EVENT_TYPES.SELL_EXECUTED,
  ]);
  if (ev.channel === 'group' || ev.channel === 'both') return ev.channel;
  if (groupTypes.has(ev.type)) return 'both';
  return 'dm';
}

export function isSilent(ev) {
  if (ev.silent != null) return ev.silent;
  return ev.type === EVENT_TYPES.PROJECT_DISCOVERED || ev.type === EVENT_TYPES.MINT_PREVIEW;
}

export { EVENT_TYPES };
