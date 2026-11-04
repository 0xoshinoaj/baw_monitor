/** 進度算法：不合理讀值直接丟棄，不假裝 0%。 */

export function isReasonableSold(sold) {
  return Number.isFinite(sold) && sold >= 0 && sold < 1e12;
}

export function isReasonableCap(cap, sold = 0) {
  return Number.isFinite(cap) && cap > 10 && cap >= sold && cap < 1e12;
}

export function isReasonablePct(pct) {
  return Number.isFinite(pct) && pct >= 0 && pct <= 100;
}

/**
 * 已售／上限。
 * @param {number} sold
 * @param {number} cap
 */
export function progressFromSoldCap(sold, cap) {
  if (!isReasonableSold(sold) || !isReasonableCap(cap, sold)) {
    return { pct: null, sold: isReasonableSold(sold) ? sold : null, cap: null, how: 'soldCap', reliable: false };
  }
  const pct = (sold / cap) * 100;
  if (!isReasonablePct(pct)) {
    return { pct: null, sold, cap, how: 'soldCap', reliable: false };
  }
  return { pct, sold, cap, how: 'soldCap', reliable: true };
}

/**
 * 鑄造池剩餘：init 為合約剛部署時持有量，now 為現在持有量。
 * 若 init 不合理或 now > init，丟棄。
 */
export function progressFromInventory(init, now) {
  const i = BigInt(init ?? -1);
  const n = BigInt(now ?? -1);
  if (i <= 0n || n < 0n || n > i) {
    return { pct: null, sold: null, cap: null, how: 'inventory', reliable: false };
  }
  const pct = Number(i - n) / Number(i) * 100;
  if (!isReasonablePct(pct)) {
    return { pct: null, sold: null, cap: null, how: 'inventory', reliable: false };
  }
  return { pct, sold: null, cap: null, how: 'inventory', reliable: true };
}

/**
 * 已發出份數／總份數：用最常見的單筆鑄造數量當 unit。
 */
export function progressFromUnits(init, now, unit, cap) {
  const i = BigInt(init ?? -1);
  const n = BigInt(now ?? -1);
  const u = BigInt(unit ?? 0);
  if (i <= 0n || n < 0n || n > i || u <= 0n || !isReasonableCap(cap)) {
    return { pct: null, sold: null, cap: null, how: 'units', reliable: false };
  }
  const sold = Number((i - n) / u);
  return progressFromSoldCap(sold, cap);
}

/** meme-rush 的 progress 已是 0–100 字串／數字，不要再乘 100。 */
export function progressFromListing(raw) {
  if (raw == null || raw === '') return { pct: null, sold: null, cap: null, how: 'listing', reliable: false };
  const n = Number(raw);
  if (!isReasonablePct(n)) return { pct: null, sold: null, cap: null, how: 'listing', reliable: false };
  return { pct: n, sold: null, cap: null, how: 'listing', reliable: true };
}

export function pickBestProgress(candidates) {
  const ok = candidates.filter((p) => p && p.reliable && isReasonablePct(p.pct));
  if (!ok.length) return candidates.find((p) => p) || { pct: null, sold: null, cap: null, how: '', reliable: false };
  const rank = { soldCap: 3, units: 2, listing: 1, inventory: 0 };
  ok.sort((a, b) => (rank[b.how] || 0) - (rank[a.how] || 0));
  return ok[0];
}

function fmtPct(n) {
  const t = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

export function thresholdsMet(progress, heat, cfg) {
  const needPct = Number(cfg.thresholds.progressPct);
  const needWallets = Number(cfg.thresholds.agentIdWallets);
  const wallets = heat?.agentIdWallets || 0;
  const walletReason = wallets >= needWallets
    ? `Agent ID 錢包數 ${wallets} 已達 ${needWallets}`
    : `Agent ID 錢包數 ${wallets} 未達 ${needWallets}`;
  if (progress?.reliable && progress.pct != null) {
    const progressReason = progress.pct >= needPct
      ? `鑄造進度 ${fmtPct(progress.pct)}% 已達 ${needPct}%`
      : `鑄造進度 ${fmtPct(progress.pct)}% 未達 ${needPct}%`;
    return {
      ok: progress.pct >= needPct && wallets >= needWallets,
      reasons: [progressReason, walletReason],
    };
  }
  return {
    ok: wallets >= needWallets,
    reasons: ['進度讀不到，改看熱度', walletReason],
  };
}
