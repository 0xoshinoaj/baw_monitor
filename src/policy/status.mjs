import { formatProjectRef } from '../project/registry.mjs';

/** 同一項目同一原因至少隔這麼久才再印。 */
export const WATCH_STATUS_INTERVAL_MS = 90_000;
export const SLOW_CHECK_MS = 10_000;

const lastLog = new Map();

function fmtPct(n) {
  const t = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

export function resetWatchLogState() {
  lastLog.clear();
}

/**
 * 同一項目同一原因不每秒刷；原因變了或過了間隔才再印。
 * @param {string} address
 * @param {string} key
 */
export function shouldLogWatchStatus(address, key, now = Date.now(), intervalMs = WATCH_STATUS_INTERVAL_MS) {
  const addr = String(address || '').toLowerCase();
  if (!addr || !key) return false;
  const prev = lastLog.get(addr);
  if (!prev || prev.key !== key || now - prev.at >= intervalMs) {
    lastLog.set(addr, { key, at: now });
    return true;
  }
  return false;
}

function needPctOf(cfg) {
  return Number(cfg?.thresholds?.progressPct);
}

function needWalletsOf(cfg) {
  return Number(cfg?.thresholds?.agentIdWallets);
}

function progressReadable(project) {
  return !!(project?.progress?.reliable && project.progress.pct != null);
}

/**
 * 評估中的 watching 項目：編號、免費／付費、進度／錢包門檻、為什麼先追蹤。
 * @returns {{ key: string, line: string }}
 */
export function watchStatusSnapshot(project, decision, cfg, extra = {}) {
  const ref = formatProjectRef(project) || project?.address || '';
  const paid = !!decision?.paid;
  const kindPart = paid ? '付費' : '免費';
  const needPct = needPctOf(cfg);
  const needWallets = needWalletsOf(cfg);
  const wallets = project?.heat?.agentIdWallets || 0;
  const readable = progressReadable(project);
  const pct = readable ? project.progress.pct : null;
  const progressPart = readable ? `進度 ${fmtPct(pct)}%/${needPct}%` : '進度讀不到改看熱度';
  const walletPart = `錢包 ${wallets}/${needWallets}`;
  const reasons = decision?.reasons || [];
  const mode = decision?.mode || '';

  let key = '';
  let why = '';

  if (reasons.includes('這個錢包已經打過')) {
    return { key: '', line: '' };
  }

  if (reasons.includes('尚未判定為 Agent ID 專屬')) {
    key = 'not_exclusive';
    why = '尚未判定為 Agent ID 專屬，先追蹤';
  } else if (!readable && wallets < needWallets) {
    key = 'heat_below';
    why = `讀不到進度，目前 ${wallets} 個錢包在打，要 ${needWallets} 個以上才打，先追蹤`;
  } else if (readable && pct < needPct) {
    key = 'progress_below';
    why = `進度 ${fmtPct(pct)}% 還沒到 ${needPct}%，先追蹤，到了再檢查`;
  } else if (readable && wallets < needWallets) {
    key = 'wallets_below';
    why = `進度 ${fmtPct(pct)}% 夠了，但只有 ${wallets} 個 Agent ID 錢包在打（要 ${needWallets} 個以上，防灌進度），先追蹤`;
  } else if (decision?.action === 'notify' && reasons.some((r) => r.includes('每錢包'))) {
    key = 'no_cap';
    why = '付費合約沒有每錢包／每筆上限，只通知不自動打';
  } else if (decision?.action === 'block') {
    key = `block:${decision.reason || ''}`;
    why = decision.reason || '策略擋下';
  } else if (decision?.action === 'notify') {
    key = 'notify_only';
    why = `達門檻（模式 ${mode}），${kindPart}只通知不自動打`;
  } else if (decision?.action === 'confirm') {
    key = 'confirm';
    why = '達門檻，等待確認';
  } else if (decision?.action === 'auto') {
    return { key: '', line: '' };
  } else if (decision?.action === 'ignore' && !decision?.thresholdsMet) {
    key = `ignore:${decision.reason || ''}`;
    why = decision.reason || '未達門檻，先追蹤';
  } else {
    return { key: '', line: '' };
  }

  if (extra.justOpened) {
    key = `opened|${key}`;
    why = `之前還沒開，現在開了（${kindPart}），照規則檢查。${why}`;
  }

  const line = `追蹤 ${ref} ${kindPart} ${progressPart} ${walletPart} ${why}`;
  return { key, line };
}

export function markSeenClosed(project) {
  if (!project) return false;
  const justOpened = !!(project.seenClosed && project.isAgentIdExclusive);
  if (!project.isAgentIdExclusive) project.seenClosed = true;
  else if (justOpened) project.seenClosed = false;
  return justOpened;
}
