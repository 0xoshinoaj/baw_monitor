import { holdsAgentIdBatch, classifyAgentIdExclusive, readMeta, resolveImpl } from '../chain/code.mjs';
import { countAgentHeat, HEAT_FRESH_MS, HEAT_LOOKBACK_BLOCKS, heatIsFresh, mergeHeat, recipientsFromMintLogs } from '../classify/heat.mjs';
import { detectPerWalletCap, isPaidKind } from '../classify/mint-kind.mjs';
import { pickBestProgress, progressFromListing, progressFromSoldCap } from '../classify/progress.mjs';
import { TOPIC_TRANSFER, ZERO, CAP_SELS, SOLD_SELS } from '../lib/const.mjs';
import { loadBondingContext } from '../exec/bonding.mjs';
import { codeFingerprint, firstWord, padTopicAddress } from '../lib/util.mjs';
import { isSerialDeployer, isSerialFingerprint, noteDeployer, noteFingerprint } from '../policy/rules.mjs';

/** 對該合約打有地址的 Transfer from 0 getLogs，再 holdsAgentIdBatch 寫回 heat。不走鑄造事件全鏈 logs 池。 */
export async function refreshAgentIdWallets(rpc, project, opts = {}) {
  if (!project.heat) project.heat = { agentIdWallets: 0, txs: 0, windowMs: 0, updatedAt: 0 };
  const now = opts.now ?? Date.now();
  const freshMs = opts.freshMs ?? HEAT_FRESH_MS;
  if (heatIsFresh(project.heat, now, freshMs)) return project.heat;

  const lookback = opts.lookbackBlocks ?? HEAT_LOOKBACK_BLOCKS;
  const windowMs = opts.windowMs ?? HEAT_FRESH_MS;
  try {
    const head = await rpc.blockNumber();
    const from = Math.max(0, Number(head) - lookback);
    const logs = await rpc.getLogs({
      address: project.address,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + Number(head).toString(16),
      topics: [TOPIC_TRANSFER, padTopicAddress(ZERO)],
    });
    const tos = recipientsFromMintLogs(logs);
    const uniq = [...new Set(tos)];
    const map = uniq.length ? await holdsAgentIdBatch(rpc, uniq) : new Map();
    const next = countAgentHeat(tos, map);
    project.heat = mergeHeat(project.heat, { ...next, windowMs }, windowMs);
  } catch {
    /* 查不到就沿用舊數字，下一輪再試 */
  }
  return project.heat;
}

export async function enrichProject(rpc, project, cfg, risk) {
  const code = await rpc.getCode(project.address).catch(() => '0x');
  const full = await resolveImpl(rpc, project.address, code);
  const meta = await readMeta(rpc, project.address).catch(() => ({}));
  if (meta.symbol) project.symbol = project.symbol || meta.symbol;
  if (meta.name) project.name = project.name || meta.name;
  if (meta.deployer) project.deployer = project.deployer || meta.deployer;
  if (meta.tokenAddress) project.tokenAddress = meta.tokenAddress;

  const sample = [];
  const exclusive = await classifyAgentIdExclusive(rpc, project.address, full, sample);
  if (exclusive.exclusive) {
    project.isAgentIdExclusive = true;
    project.agentIdReason = exclusive.reason;
  }

  try {
    const ctx = await loadBondingContext(rpc, project.tokenAddress || project.address);
    if (ctx?.exists && ctx.isAgentIdExclusive) {
      project.isAgentIdExclusive = true;
      project.kind = 'bonding';
      project.paid = true;
      project.stage = ctx.market === 'outer' ? 'dex' : (ctx.route === 'wait' ? 'migrating' : 'bonding');
      const pct = ctx.curve.raisedPercent != null ? Number(ctx.curve.raisedPercent) : null;
      if (pct != null) project.progress = { pct, sold: null, cap: null, how: 'listing', reliable: true };
    }
  } catch { /* 不是 Open Four 代幣 */ }

  if (project.progress?.how === 'listing' && project.progress.pct != null) {
    project.progress = pickBestProgress([project.progress, progressFromListing(project.progress.pct)]);
  }

  if (!project.progress?.reliable) {
    let sold = null;
    let cap = null;
    for (const s of SOLD_SELS) {
      if (!full.includes(s)) continue;
      const r = await rpc.call(project.address, '0x' + s).catch(() => null);
      if (r && r.length >= 66) { sold = Number(firstWord(r)); break; }
    }
    if (sold != null) {
      for (const s of CAP_SELS) {
        if (!full.includes(s)) continue;
        const r = await rpc.call(project.address, '0x' + s).catch(() => null);
        if (r && r.length >= 66) {
          const x = Number(firstWord(r));
          if (x > 10 && x >= sold && x < 1e12) { cap = x; break; }
        }
      }
    }
    const fromChain = progressFromSoldCap(sold, cap);
    project.progress = pickBestProgress([project.progress, fromChain]);
  }

  if (project.kind === 'unknown') {
    if (full.includes('995ee6da') || full.includes('247d525e')) {
      project.kind = 'bonding';
      project.paid = true;
    }
  }
  project.paid = project.paid || isPaidKind(project.kind);

  const capN = await detectPerWalletCap(rpc, project.address, full).catch(() => null);
  if (capN != null) project.mint.perWalletCap = capN;
  if (project.kind === 'bonding') project.mint.perWalletCap = project.mint.perWalletCap ?? 1;
  project.mint.adapter = project.kind === 'bonding' ? 'bonding' : project.mint.adapter;

  const fp = codeFingerprint(full);
  const n = noteFingerprint(risk.data, fp);
  if (isSerialFingerprint(risk.data, fp, cfg.thresholds.serialDeployMax)) {
    project.risk.serial = true;
    project.risk.flags.push('serialBytecode');
  }
  if (project.deployer) {
    noteDeployer(risk.data, project.deployer, project.address);
    if (isSerialDeployer(risk.data, project.deployer, cfg.thresholds.serialDevMax)) {
      project.risk.serial = true;
      project.risk.flags.push('serialDeployer');
    }
    if ((risk.data.blacklist || []).includes(project.deployer)) project.risk.blacklist = true;
  }
  void n;
  await refreshAgentIdWallets(rpc, project);
  return project;
}
