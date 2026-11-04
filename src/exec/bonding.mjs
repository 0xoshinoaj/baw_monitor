import { execFile } from 'node:child_process';
import {
  AGENT_ID_PRESET_ID, BINANCE_CHAIN_ID, OPEN_FOUR_REGISTRY, SEL, ZERO,
} from '../lib/const.mjs';
import { encAddr, encUint, firstWord, formatUnits, lc, parseUnits, safeJson, wordAddr } from '../lib/util.mjs';
import { decodeEstimate, encWithEmptyBytes } from '../chain/abi.mjs';

const PHASES = ['Created', 'Trading', 'MigratePending', 'Migrated', 'Terminal', 'SoldOut'];
const OPT_ZAP_NATIVE = 2n;
const BPS = 10_000n;
const slipDown = (x, bps) => (x * (BPS - bps)) / BPS;
const percent = (num, den) => (den === 0n ? null : formatUnits((num * 10_000n) / den, 2));

export async function loadBondingContext(rpc, token, wallet = null) {
  const [coreHex, toolsHex] = await rpc.multicall([
    { to: OPEN_FOUR_REGISTRY, data: SEL.registryCore },
    { to: OPEN_FOUR_REGISTRY, data: SEL.registryTools },
  ]);
  if (!coreHex || !toolsHex) return null;
  const core = wordAddr(firstWord(coreHex));
  const tools = wordAddr(firstWord(toolsHex));
  const [cfgHex, wnHex, zapHex, tokenPhaseHex, tokenDecHex, tokenSymHex] = await rpc.multicall([
    { to: core, data: SEL.tokens + encAddr(token) },
    { to: core, data: SEL.wrappedNative },
    { to: core, data: SEL.zapRouter },
    { to: token, data: SEL.tokenPhase },
    { to: token, data: SEL.decimals },
    { to: token, data: SEL.symbol },
  ]);
  if (!cfgHex || !wnHex) return { exists: false, core, tools };
  const w = (await import('../lib/util.mjs')).words(cfgHex);
  const cfg = {
    creator: wordAddr(w[1]),
    presetId: w[2],
    maxSupply: w[6],
    saleAmount: w[7],
    raiseAmount: w[8],
    quoteAsset: wordAddr(w[9]),
    vault: wordAddr(w[10]),
    migrateModule: wordAddr(w[13]),
    exists: w[17] === 1n,
    paused: w[18] === 1n,
  };
  if (!cfg.exists) return { exists: false, core, tools, route: 'unsupported' };

  const calls = [
    { to: cfg.vault, data: SEL.totalRaised },
    { to: cfg.vault, data: SEL.remainingForSale },
    { to: OPEN_FOUR_REGISTRY, data: SEL.isPresetActive + encUint(cfg.presetId) },
    { to: cfg.quoteAsset, data: SEL.decimals },
    { to: cfg.vault, data: SEL.phase },
  ];
  if (wallet) {
    calls.push(
      { to: token, data: SEL.balanceOf + encAddr(wallet) },
      { to: token, data: SEL.allowance + encAddr(wallet) + encAddr(core) },
    );
  }
  const r = await rpc.multicall(calls);
  const [raisedHex, remainingHex, activeHex, quoteDecHex, vaultPhaseHex] = r;
  const phase = Number(firstWord(tokenPhaseHex ?? vaultPhaseHex ?? '0x0'));
  const totalRaised = raisedHex ? firstWord(raisedHex) : 0n;
  const quoteDecimals = quoteDecHex ? Number(firstWord(quoteDecHex)) : 18;
  const tokenDecimals = tokenDecHex ? Number(firstWord(tokenDecHex)) : 18;
  const { decodeString } = await import('../lib/util.mjs');
  const isAgentIdExclusive = cfg.presetId === AGENT_ID_PRESET_ID;
  const presetActive = activeHex ? firstWord(activeHex) === 1n : false;
  const wrappedNative = wordAddr(firstWord(wnHex));
  const zapRouter = zapHex ? wordAddr(firstWord(zapHex)) : ZERO;
  const quoteIsWrappedNative = lc(cfg.quoteAsset) === lc(wrappedNative);
  const market = phase === 3 ? 'outer' : 'inner';
  let route = 'unavailable';
  if (phase === 3) route = 'market-order';
  else if (phase === 2 || phase === 5) route = 'wait';
  else if (phase === 1 && !cfg.paused && presetActive) route = isAgentIdExclusive ? 'contract-call' : 'market-order';

  return {
    exists: true,
    core,
    tools,
    token: { address: lc(token), decimals: tokenDecimals, symbol: decodeString(tokenSymHex) || '' },
    quote: { address: cfg.quoteAsset, decimals: quoteDecimals, isWrappedNative: quoteIsWrappedNative },
    creator: cfg.creator,
    presetId: cfg.presetId.toString(),
    isAgentIdExclusive,
    market,
    route,
    zapRouter,
    vault: cfg.vault,
    curve: {
      phase: { code: phase, name: PHASES[phase] || 'Unknown' },
      paused: cfg.paused,
      totalRaised: formatUnits(totalRaised, quoteDecimals),
      raiseTarget: formatUnits(cfg.raiseAmount, quoteDecimals),
      raisedPercent: percent(totalRaised, cfg.raiseAmount),
      remainingForSale: remainingHex ? formatUnits(firstWord(remainingHex), tokenDecimals) : null,
    },
    walletState: wallet ? { tokenBalance: r[5] ? firstWord(r[5]) : 0n, tokenAllowanceToCore: r[6] ? firstWord(r[6]) : 0n } : null,
  };
}

export async function quoteBuyOnChain(rpc, { token, wallet, amount, slippageBps = 2000 }) {
  const ctx = await loadBondingContext(rpc, token, wallet);
  if (!ctx?.exists) throw new Error('NOT_ON_BONDING_CURVE');
  if (ctx.route !== 'contract-call') throw new Error(ctx.route === 'wait' ? 'MIGRATING' : `ROUTE_${ctx.route}`);
  const payNative = true;
  const zap = payNative && !ctx.quote.isWrappedNative;
  const options = zap ? OPT_ZAP_NATIVE : 0n;
  const input = parseUnits(amount, 18, 'amount');
  const estHex = await rpc.call(ctx.tools, encWithEmptyBytes(
    SEL.estimateBuyByBudget,
    [encAddr(token), encAddr(wallet), encUint(input), encUint(options)],
  ));
  const est = decodeEstimate(estHex);
  if (est.tokenAmount === 0n) throw new Error('NOT_EXECUTABLE');
  const quoteCost = est.curveQuote + est.totalFee;
  const maxQuotePay = zap ? quoteCost : input;
  const minTokenOut = slipDown(est.tokenAmount, BigInt(slippageBps));
  const tx = {
    from: wallet,
    to: ctx.core,
    value: input.toString(),
    inputData: encWithEmptyBytes(SEL.buyByBudget, [encAddr(token), encUint(maxQuotePay), encUint(minTokenOut), encUint(options)]),
  };
  return {
    ctx,
    tx,
    estimate: {
      tokenAmount: formatUnits(est.tokenAmount, ctx.token.decimals),
      userPays: formatUnits(est.userPays, 18),
    },
    minTokenOut: formatUnits(minTokenOut, ctx.token.decimals),
    slippageBps,
  };
}

export async function quoteSellOnChain(rpc, { token, wallet, amountRaw, slippageBps = 2000 }) {
  const ctx = await loadBondingContext(rpc, token, wallet);
  if (!ctx?.exists || ctx.route !== 'contract-call') throw new Error('NOT_ON_BONDING_CURVE');
  const amt = BigInt(amountRaw);
  const estHex = await rpc.call(ctx.tools, encWithEmptyBytes(
    SEL.estimateSell,
    [encAddr(token), encAddr(wallet), encUint(amt), encUint(0)],
  ));
  const est = decodeEstimate(estHex);
  const minRecv = slipDown(est.userReceives, BigInt(slippageBps));
  const needApprove = ctx.walletState && ctx.walletState.tokenAllowanceToCore < amt;
  return {
    ctx,
    approveTx: needApprove ? {
      to: token,
      value: '0',
      inputData: SEL.approve + encAddr(ctx.core) + encUint(amt),
    } : null,
    tx: {
      from: wallet,
      to: ctx.core,
      value: '0',
      inputData: encWithEmptyBytes(SEL.sell, [encAddr(token), encUint(amt), encUint(minRecv), encUint(0)]),
    },
    estimate: { userReceives: formatUnits(est.userReceives, 18) },
  };
}

function spawnScript(script, cmd, params) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, cmd, JSON.stringify(params)], { timeout: 30_000 }, (err, stdout, stderr) => {
      const j = safeJson(stdout || stderr || '');
      if (!j) return reject(err || new Error(stderr || 'script 無 JSON'));
      if (!j.success) return reject(Object.assign(new Error(j.error?.message || cmd), { code: j.error?.code, extra: j }));
      resolve(j.data);
    });
  });
}

export async function officialInfo(script, token, wallet) {
  return spawnScript(script, 'info', { token, wallet });
}

export async function officialQuoteBuy(script, params) {
  return spawnScript(script, 'quote-buy', params);
}

export async function officialQuoteSell(script, params) {
  return spawnScript(script, 'quote-sell', params);
}

export function previewCommand(tx) {
  return `baw contract-call preview --binanceChainId ${BINANCE_CHAIN_ID} --from ${tx.from} --to ${tx.to} --value ${tx.value} --inputData ${tx.inputData} --json`;
}

export async function resolveBuyTx(rpc, cfg, { token, wallet }) {
  const amount = cfg.official.buyAmountBnb || '0.05';
  const slippageBps = cfg.official.slippageBps || 2000;
  if (cfg.official.agentIdScript) {
    const q = await officialQuoteBuy(cfg.official.agentIdScript, { token, wallet, amount, slippageBps });
    return { tx: q.tx, estimate: q.estimate, source: 'officialScript' };
  }
  const q = await quoteBuyOnChain(rpc, { token, wallet, amount, slippageBps });
  return { tx: q.tx, estimate: q.estimate, source: 'onchain', ctx: q.ctx };
}
