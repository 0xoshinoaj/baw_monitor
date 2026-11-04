/**
 * 賣出決策（純函式）。
 * 付費：backX / steps / crash / crashAfterBack / moonPct
 * 免費：只通知倍數，回落才賣。
 */

export function decideSell({
  paid,
  hold = false,
  costUsd = 0,
  valueUsd = 0,
  px = 0,
  peakPx = 0,
  basePx = 0,
  backDone = false,
  doneSteps = [],
  notified = [],
  rules,
}) {
  const reasons = [];
  if (!(px > 0) && !(valueUsd > 0)) return { action: 'wait', sellPct: 0, notifyX: null, reasons: ['尚無價格'] };
  if (hold) {
    const x = multiple(paid, costUsd, valueUsd, px, basePx);
    const hit = (rules.notifyX || []).find((n) => x >= n && !notified.includes(n));
    if (hit) return { action: 'notify', sellPct: 0, notifyX: hit, reasons: [`手動 hold，到 ${hit} 倍只通知`] };
    return { action: 'hold', sellPct: 0, notifyX: null, reasons: ['手動 hold'] };
  }

  if (!paid || !(costUsd > 0)) {
    const x = basePx > 0 ? px / basePx : 0;
    const hit = (rules.notifyX || []).find((n) => x >= n && !notified.includes(n));
    const drop = peakPx > 0 && px < peakPx * (1 - Number(rules.freeDrop || 0.5));
    if (drop) return { action: 'sell', sellPct: 100, notifyX: null, reasons: [`免費幣從最高回落 ${Math.round((rules.freeDrop || 0.5) * 100)}%`] };
    if (hit) return { action: 'notify', sellPct: 0, notifyX: hit, reasons: [`免費幣到開盤價 ${hit} 倍`] };
    return { action: 'wait', sellPct: 0, notifyX: null, reasons };
  }

  const x = valueUsd / costUsd;
  const crash = backDone ? Number(rules.crashAfterBack ?? rules.crash ?? 0.4) : Number(rules.crash ?? 0.4);
  if (peakPx > 0 && px < peakPx * (1 - crash)) {
    return { action: 'sell', sellPct: 100, notifyX: null, reasons: [`從最高回落 ${Math.round(crash * 100)}%`] };
  }

  if (!backDone && x >= Number(rules.backX || 2)) {
    return { action: 'sell', sellPct: backSellPct(rules.backX, rules.moonPct), notifyX: null, reasons: [`到 ${rules.backX} 倍回本`], tag: 'back' };
  }

  for (const [mult, pct] of rules.steps || []) {
    if (!doneSteps.includes('s' + mult) && x >= Number(mult)) {
      return { action: 'sell', sellPct: Number(pct), notifyX: null, reasons: [`到 ${mult} 倍，賣 ${pct}%`], tag: 's' + mult };
    }
  }

  const hit = (rules.notifyX || []).find((n) => x >= n && !notified.includes(n));
  if (hit) return { action: 'notify', sellPct: 0, notifyX: hit, reasons: [`到 ${hit} 倍`] };
  if (backDone) {
    for (const n of rules.moonNotifyX || []) {
      if (x >= n && !notified.includes('m' + n) && !doneSteps.includes('m' + n)) {
        return { action: 'notify', sellPct: 0, notifyX: n, reasons: [`長抱到 ${n} 倍`], tag: 'm' + n };
      }
    }
  }
  return { action: 'wait', sellPct: 0, notifyX: null, reasons };
}

function multiple(paid, costUsd, valueUsd, px, basePx) {
  if (paid && costUsd > 0) return valueUsd / costUsd;
  if (basePx > 0) return px / basePx;
  return 0;
}

/** 把回本賣出比例正規化成 0–100。backX=2 → 賣 50%；若 moonPct=20 → 賣 80% 的一半＝40%，此處簡化為 100/backX，再被 moon 下限夾住。 */
export function backSellPct(backX, moonPct = 0) {
  const x = Number(backX) || 2;
  let pct = 100 / x;
  if (moonPct > 0) pct = Math.min(pct, 100 - Number(moonPct));
  return Math.max(0, Math.min(100, pct));
}

export function normalizeSellDecision(d, rules) {
  if (d.tag === 'back') {
    return { ...d, sellPct: backSellPct(rules.backX, rules.moonPct) };
  }
  return d;
}
