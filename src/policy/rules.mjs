import { isPaidKind } from '../classify/mint-kind.mjs';
import { thresholdsMet } from '../classify/progress.mjs';

export const ACTIONS = ['ignore', 'notify', 'confirm', 'auto', 'block'];

const FAIL_REASON_RE = /未達|沒有|缺少|黑名單|抽光|連續|上限 ≤|≥ 每日上限/;

export function pickFailReasons(reasons = []) {
  const fail = reasons.filter((r) => FAIL_REASON_RE.test(r));
  return fail.length ? fail : [...reasons];
}

export function displayReason(reasons = []) {
  return pickFailReasons(reasons).join('；');
}

/** 策略擋住時給 log／通知的單一原因；尚未判定或已鑄過不當擋住。 */
export function strategyBlockReason(d) {
  const reasons = d?.reasons || [];
  if (reasons.includes('尚未判定為 Agent ID 專屬') || reasons.includes('這個錢包已經打過')) return '';
  if (d.action === 'block') return d.reason || displayReason(reasons);
  if (d.action === 'ignore' && !d.thresholdsMet) return d.reason || displayReason(reasons);
  if (d.action === 'notify' && reasons.some((r) => r.includes('每錢包'))) {
    return reasons.find((r) => r.includes('每錢包')) || d.reason || '';
  }
  return '';
}

function pack(action, mode, paid, thresholdsMetFlag, reasons, reason) {
  const list = reasons || [];
  return {
    action,
    mode,
    paid,
    thresholdsMet: thresholdsMetFlag,
    reasons: list,
    reason: reason || displayReason(list),
  };
}

function modeFor(project, cfg) {
  return isPaidKind(project.kind) || project.paid ? cfg.execution.paid : cfg.execution.free;
}

function budgetOk(project, cfg, risk, walletName) {
  const reasons = [];
  const spent = Number(risk.spendUsd?.[walletName] || 0);
  const maxDay = Number(cfg.budget.maxUsdPerDay);
  const maxProj = Number(cfg.budget.maxUsdPerProject);
  if (spent >= maxDay) {
    reasons.push(`今日已花 ${spent.toFixed(2)}U ≥ 每日上限 ${maxDay}U`);
    return { ok: false, reasons };
  }
  reasons.push(`今日已花 ${spent.toFixed(2)}U / ${maxDay}U`);
  if ((isPaidKind(project.kind) || project.paid) && maxProj <= 0) {
    return { ok: false, reasons: [...reasons, '每項目上限 ≤ 0'] };
  }
  return { ok: true, reasons, maxUsdPerProject: maxProj };
}

/**
 * 單一真相：打或不打只看這份宣告式政策。
 * @returns {{ action: string, mode: string, paid: boolean, thresholdsMet: boolean, reasons: string[], reason: string }}
 */
export function decide(project, cfg, risk = {}, extra = {}) {
  const paid = !!(isPaidKind(project.kind) || project.paid);
  const mode = extra.forceMode || modeFor(project, cfg);
  const reasons = [];

  if (project.risk?.blacklist || (risk.blacklist || []).includes(project.address) || (risk.blacklist || []).includes(project.deployer)) {
    return pack('block', mode, paid, false, ['部署者或合約在黑名單']);
  }
  if (project.risk?.drain) {
    return pack('block', mode, paid, false, ['合約資金疑似被抽光']);
  }
  if (project.risk?.serial) {
    return pack('block', mode, paid, false, ['連續／批量同 bytecode 部署']);
  }
  if (project.walletState?.[extra.walletName] === 'minted') {
    return pack('ignore', mode, paid, true, ['這個錢包已經打過']);
  }
  if (!project.isAgentIdExclusive && !extra.forceMint) {
    return pack('ignore', mode, paid, false, ['尚未判定為 Agent ID 專屬']);
  }

  const thr = thresholdsMet(project.progress, project.heat, cfg);
  reasons.push(...thr.reasons);

  if (paid && cfg.thresholds.requirePerWalletCap && project.mint?.perWalletCap == null && project.kind !== 'bonding' && !extra.forceMint) {
    reasons.push('付費合約沒有每錢包／每筆上限');
    return pack('notify', mode, paid, false, reasons, '付費合約沒有每錢包／每筆上限');
  }

  const bud = budgetOk(project, cfg, risk, extra.walletName || '');
  reasons.push(...bud.reasons);
  if (!bud.ok) return pack('block', mode, paid, thr.ok, reasons);

  if (!thr.ok && !extra.forceMint) {
    return pack('ignore', mode, paid, false, reasons);
  }

  if (mode === 'notify') return pack('notify', mode, paid, true, reasons);
  if (mode === 'confirm') return pack('confirm', mode, paid, true, reasons);
  return pack('auto', mode, paid, true, reasons);
}

export function noteFingerprint(risk, fingerprint, now = Date.now()) {
  const fps = risk.fingerprints || (risk.fingerprints = {});
  const arr = (fps[fingerprint] || []).filter((t) => now - t < 86_400_000);
  arr.push(now);
  fps[fingerprint] = arr.slice(-20);
  return arr.length;
}

export function isSerialFingerprint(risk, fingerprint, max = 3, now = Date.now()) {
  const arr = (risk.fingerprints || {})[fingerprint] || [];
  return arr.filter((t) => now - t < 86_400_000).length >= max;
}

export function noteDeployer(risk, deployer, contract, now = Date.now()) {
  if (!deployer) return 0;
  const devs = risk.deployers || (risk.deployers = {});
  const arr = (devs[deployer] || []).filter((x) => now - x.t < 86_400_000 && x.c !== contract);
  arr.push({ t: now, c: contract });
  devs[deployer] = arr.slice(-30);
  return arr.length;
}

export function isSerialDeployer(risk, deployer, max = 10, now = Date.now()) {
  if (!deployer) return false;
  const arr = (risk.deployers || {})[deployer] || [];
  return arr.filter((x) => now - x.t < 86_400_000).length >= max;
}
