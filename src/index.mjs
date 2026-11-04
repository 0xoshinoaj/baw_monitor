#!/usr/bin/env node
/**
 * Agent ID 監控／自動鑄造主迴圈。
 * 發現 → 登錄 → 分類／進度 → 政策 → baw preview 檢查 → execute → 持倉／通知。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.mjs';
import { EVENT_TYPES } from './lib/const.mjs';
import { acquireLock } from './lib/lock.mjs';
import { createLogger } from './lib/log.mjs';
import { sleep } from './lib/util.mjs';
import { openStores, rolloverDay, saveAll } from './store/stores.mjs';
import { createRpc } from './chain/rpc.mjs';
import { createDiscovery } from './discovery/index.mjs';
import { logHeatCandidates } from './discovery/heat.mjs';
import { createRegistry, formatProjectRef, pickMaintainBatch, shouldLogBlockReason } from './project/registry.mjs';
import { enrichProject } from './project/enrich.mjs';
import { decide, strategyBlockReason } from './policy/rules.mjs';
import { markSeenClosed, shouldLogWatchStatus, SLOW_CHECK_MS, watchStatusSnapshot } from './policy/status.mjs';
import { createBawClients } from './exec/baw.mjs';
import { enqueueWallet, inflightCount, mintOne } from './exec/mint.mjs';
import { createNotifier } from './notify/notify.mjs';
import { event, formatBlockedLines, formatBlockedTitle, formatBscscanLink, formatDiscoveredTitle, formatStartupLines } from './notify/events.mjs';
import { helpEvent, parseCommand } from './notify/commands.mjs';
import { bootstrap } from './setup/bootstrap.mjs';
import { refreshSession } from './watchers/session.mjs';
import { checkHoldings, formatHoldings, seedConfigTokens, statsFromStores, upsertPosition } from './watchers/holdings.mjs';

let cfg;
try {
  cfg = await bootstrap();
} catch (e) {
  if (e?.exitCode === 0) {
    if (e.message) console.log(e.message);
    process.exit(0);
  }
  console.error(e?.message || e);
  process.exit(1);
}

const log = createLogger({ file: join(ROOT, 'data', 'monitor.log'), timeZone: cfg.timeZone });
acquireLock(join(ROOT, 'data', 'monitor.lock'));

const stores = openStores();
const registry = createRegistry(stores.projects, { timeZone: cfg.timeZone });
const rpc = createRpc(cfg.rpcs, log);
const baws = createBawClients(cfg, log);
const notifier = createNotifier(cfg, log);
const tg = notifier.telegram;
const discovery = createDiscovery(cfg, rpc, stores.session, log);
seedConfigTokens(stores.positions, cfg);

let bnbUsd = 700;
async function refreshBnbUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j.price) bnbUsd = Number(j.price);
  } catch { /* 沿用上次 */ }
}

async function emit(ev) {
  await notifier.emit(ev);
}

function once(project, key) {
  if (project.notified[key]) return false;
  project.notified[key] = Date.now();
  stores.projects.mark();
  return true;
}

function noteWatchStatus(project, extra = {}) {
  const d = decide(project, cfg, stores.risk.data, { walletName: baws[0]?.wallet.name || '' });
  const snap = watchStatusSnapshot(project, d, cfg, extra);
  if (snap.line && shouldLogWatchStatus(project.address, snap.key)) {
    log.info(snap.line);
  }
}

async function actOn(project) {
  const risk = rolloverDay(stores.risk, cfg.timeZone);
  for (const baw of baws) {
    const force = cfg.forceMint.includes(project.address);
    const d = decide(project, cfg, risk, { walletName: baw.wallet.name, forceMint: force });
    const blockReason = strategyBlockReason(d);
    if (blockReason) {
      if (shouldLogBlockReason(project, blockReason)) {
        stores.projects.mark();
        await emit(event(EVENT_TYPES.MINT_BLOCKED, {
          title: formatBlockedTitle(project, blockReason),
          lines: formatBlockedLines(project, cfg, risk, { walletName: baw.wallet.name, decision: d }),
          address: project.address,
        }));
      }
      if (d.action !== 'auto' && d.action !== 'confirm') continue;
    }
    if (d.action === 'ignore' || d.action === 'block') {
      continue;
    }
    if (d.action === 'notify') {
      if (once(project, 'eligible')) {
        await emit(event(EVENT_TYPES.PROJECT_ELIGIBLE, {
          title: `${formatProjectRef(project)} 達門檻（${d.paid ? '付費' : '免費'}／模式 ${d.mode}）`,
          lines: d.reasons.concat([
            `來源 ${project.sources.join(',')}`,
            formatBscscanLink(project.address),
            d.mode === 'notify' ? '此檔只通知，不自動打' : '',
          ].filter(Boolean)),
          address: project.address,
        }));
      }
      continue;
    }
    if (d.action === 'confirm') {
      stores.session.data.pendingConfirm[project.address] = { at: Date.now(), reasons: d.reasons };
      stores.session.mark();
      if (once(project, 'confirm')) {
        await emit(event(EVENT_TYPES.MINT_PENDING_CONFIRM, {
          title: `${formatProjectRef(project)} 達門檻，等待確認`,
          lines: d.reasons.concat([`回覆：打 ${project.address}`]),
          address: project.address,
        }));
      }
      continue;
    }
    if (d.action === 'auto') {
      if (once(project, 'eligible')) {
        await emit(event(EVENT_TYPES.PROJECT_ELIGIBLE, {
          title: `${formatProjectRef(project)} 達門檻，準備 preview`,
          lines: d.reasons.concat([formatBscscanLink(project.address)]),
          address: project.address,
        }));
      }
      enqueueWallet(baw.wallet.name, () => runMint(project, baw)).catch((e) => log.error(e.message));
    }
  }
}

async function runMint(project, baw) {
  try {
    await emit(event(EVENT_TYPES.MINT_PREVIEW, {
      title: `[${baw.wallet.name}] 預演 ${formatProjectRef(project)}`,
      lines: [project.address],
      address: project.address,
      silent: true,
    }));
    const r = await mintOne({ rpc, baw, cfg, project, log, bnbUsd });
    registry.patch(project.address, (p) => { p.walletState[baw.wallet.name] = 'minted'; p.status = 'held'; });
    const paid = project.paid || project.kind !== 'free';
    if (paid) stores.risk.data.stats.paidMints++;
    else stores.risk.data.stats.freeMints++;
    stores.risk.data.spendUsd[baw.wallet.name] = (stores.risk.data.spendUsd[baw.wallet.name] || 0) + (r.costUsd || 0);
    stores.risk.data.mints[baw.wallet.name] = (stores.risk.data.mints[baw.wallet.name] || 0) + 1;
    stores.risk.mark();
    for (const t of r.tokens) {
      upsertPosition(stores.positions, {
        token: String(t.contractAddress).toLowerCase(),
        wallet: baw.wallet.address,
        walletName: baw.wallet.name,
        symbol: project.symbol,
        project: project.address,
        costUsd: r.costUsd,
        paid,
        stage: project.stage,
      });
    }
    await emit(event(EVENT_TYPES.MINT_EXECUTED, {
      title: `[${baw.wallet.name}] 已鑄造 ${formatProjectRef(project)}`,
      lines: [`adapter=${r.adapter}`, `成本約 ${(r.costUsd || 0).toFixed(2)}U`, `tx ${r.txHash || r.status}`, project.address],
      address: project.address,
    }));
  } catch (e) {
    if (e.drain) registry.patch(project.address, (p) => { p.risk.drain = true; p.risk.flags.push('drain'); });
    registry.patch(project.address, (p) => { p.walletState[baw.wallet.name] = 'failed'; });
    await emit(event(EVENT_TYPES.MINT_FAILED, {
      title: `[${baw.wallet.name}] 鑄造失敗 ${formatProjectRef(project)}`,
      lines: [e.message, project.address],
      address: project.address,
    }));
  }
}

async function handleCmd(cmd) {
  if (cmd.op === 'help' || cmd.op === 'unknown') {
    await emit(cmd.op === 'help' ? helpEvent() : event(EVENT_TYPES.CMD_REPLY, { title: '無法辨識的指令', lines: ['打「指令」看說明'] }));
    return;
  }
  if (cmd.op === 'balance') {
    const lines = [];
    for (const baw of baws) {
      const wei = await rpc.getBalance(baw.wallet.address);
      lines.push(`${baw.wallet.name}  ${Number(wei) / 1e18} BNB  ${baw.wallet.address}`);
    }
    await emit(event(EVENT_TYPES.CMD_REPLY, { title: '錢包餘額', lines }));
    return;
  }
  if (cmd.op === 'holdings') {
    await emit(event(EVENT_TYPES.CMD_REPLY, { title: '持倉', lines: formatHoldings(stores.positions) }));
    return;
  }
  if (cmd.op === 'stats') {
    const s = statsFromStores(stores.positions, stores.risk, cfg);
    await emit(event(EVENT_TYPES.CMD_REPLY, {
      title: '戰績（來自 positions / risk，不是 log）',
      lines: [
        `免費鑄造 ${s.freeMints}　付費鑄造 ${s.paidMints}`,
        `賣出 ${s.sells} 筆，約 ${s.sellUsd.toFixed(2)}U`,
        `持倉中 ${s.open}　已賣完 ${s.sold}`,
      ],
    }));
    return;
  }
  if (cmd.op === 'mint') {
    const p = registry.get(cmd.address);
    if (!p) { await emit(event(EVENT_TYPES.CMD_REPLY, { title: '找不到這個項目', lines: [cmd.address] })); return; }
    delete stores.session.data.pendingConfirm[cmd.address];
    stores.session.mark();
    for (const baw of baws) enqueueWallet(baw.wallet.name, () => runMint(p, baw));
    await emit(event(EVENT_TYPES.CMD_REPLY, { title: '已排入鑄造', lines: [cmd.address] }));
    return;
  }
  if (cmd.op === 'sell') {
    const { sellPosition, tokenBalance } = await import('./exec/sell.mjs');
    const target = cmd.target.toLowerCase();
    const hits = stores.positions.data.items.filter((p) => !p.soldAt && (p.symbol.toLowerCase() === target || p.token === target));
    if (!hits.length) { await emit(event(EVENT_TYPES.CMD_REPLY, { title: '沒有這個持倉', lines: [cmd.target] })); return; }
    await emit(event(EVENT_TYPES.CMD_REPLY, { title: `開始賣 ${cmd.target}${cmd.half ? '（一半）' : ''}` }));
    for (const pos of hits) {
      const baw = baws.find((b) => b.wallet.address === pos.wallet);
      if (!baw) continue;
      try {
        const bal = await tokenBalance(rpc, pos.token, pos.wallet);
        const amt = cmd.half ? bal / 2n : bal;
        const r = await sellPosition({ rpc, baw, pos, amountRaw: amt, reason: 'tg-cmd', log });
        if (!cmd.half) pos.soldAt = Date.now();
        stores.positions.mark();
        await emit(event(EVENT_TYPES.SELL_EXECUTED, {
          title: `[${pos.walletName}] 指令賣出 ${pos.symbol}`,
          lines: [`tx/order ${r.txHash || r.orderId || ''}`, pos.token],
          address: pos.token,
        }));
      } catch (e) {
        await emit(event(EVENT_TYPES.SELL_FAILED, { title: `賣出失敗 ${pos.symbol}`, lines: [e.message] }));
      }
    }
  }
}

async function cmdLoop() {
  if (!tg.enabled) return;
  if (!stores.session.data.tgOffset) {
    const r = await tg.poll(0);
    stores.session.data.tgOffset = r.offset;
    stores.session.mark();
  }
  for (;;) {
    const r = await tg.poll(stores.session.data.tgOffset);
    stores.session.data.tgOffset = r.offset;
    stores.session.mark();
    for (const m of r.messages) {
      const cmd = parseCommand(m.text);
      handleCmd(cmd).catch((e) => log.error('cmd ' + e.message));
    }
  }
}

let lastSession = 0;
let lastHold = 0;
let lastUsd = 0;

function stopIfAsked() {
  if (existsSync(join(ROOT, 'WATCH_STOP'))) {
    log.info('WATCH_STOP，退出');
    saveAll(stores);
    process.exit(0);
  }
}

/** 只做發現與登錄，不等 enrich／政策／通知跑完。 */
async function discoverTick() {
  stopIfAsked();
  const cands = await discovery.pollAll();
  const heatProjects = [];
  for (const c of cands) {
    const { project: p, discovered } = registry.ingest(c);
    if (p && c.source === 'heat') heatProjects.push(p);
    if (discovered && p) {
      emit(event(EVENT_TYPES.PROJECT_DISCOVERED, {
        title: formatDiscoveredTitle(p),
        lines: [`來源 ${p.sources.join(',')}`, formatBscscanLink(p.address)],
        address: p.address,
        silent: true,
      })).catch((e) => log.warn(e.message));
    }
  }
  logHeatCandidates(log, heatProjects);
  stores.session.data.lastLoopAt = Date.now();
  stores.session.mark();
  saveAll(stores);
}

/** enrich／政策／持倉與發現分開，避免主迴圈卡住掃描。 */
async function maintainTick() {
  stopIfAsked();
  rolloverDay(stores.risk, cfg.timeZone);
  if (Date.now() - lastUsd > 60_000) { lastUsd = Date.now(); await refreshBnbUsd(); }
  if (Date.now() - lastSession > 600_000) {
    lastSession = Date.now();
    for (const baw of baws) await refreshSession({ baw, rpc, session: stores.session, cfg, emit, log }).catch((e) => log.warn(e.message));
  }

  const dirty = pickMaintainBatch(registry.watching());
  for (const p of dirty) {
    const t0 = Date.now();
    try {
      registry.refreshRef(p);
      await enrichProject(rpc, p, cfg, stores.risk);
      p.lastCheckedAt = Date.now();
      registry.refreshRef(p);
      const justOpened = markSeenClosed(p);
      stores.projects.mark();
      noteWatchStatus(p, { justOpened });
      await actOn(p);
      const dt = Date.now() - t0;
      if (dt > SLOW_CHECK_MS) log.info(`檢查 ${formatProjectRef(p) || p.address} 花了 ${Math.round(dt / 1000)} 秒`);
    } catch (e) {
      log.warn(`enrich ${formatProjectRef(p) || p.address} ${e.message}`);
    }
  }

  if (Date.now() - lastHold > 8_000) {
    lastHold = Date.now();
    checkHoldings({ rpc, baws, positions: stores.positions, risk: stores.risk, cfg, emit, log, bnbUsd }).catch((e) => log.warn('holdings ' + e.message));
  }

  saveAll(stores);
}

async function loop(name, fn) {
  for (;;) {
    try { await fn(); } catch (e) { log.error(`${name} ${e.message}`); }
    await sleep(1000);
    if (name === 'maintain' && inflightCount() > 0) await sleep(500);
  }
}

async function main() {
  log.info('啟動 baw-monitor');
  log.info(`執行模式：免費=${cfg.execution.free} 付費=${cfg.execution.paid}`);
  log.info(`發現來源：${Object.entries(cfg.discovery).filter(([, v]) => v.enabled).map(([k]) => k).join(', ') || '無'}`);
  await emit(event(EVENT_TYPES.MONITOR_STARTED, {
    title: 'baw-monitor 已啟動',
    lines: formatStartupLines(cfg),
  }));
  await rpc.waitHealthy();
  for (const baw of baws) {
    await refreshSession({ baw, rpc, session: stores.session, cfg, emit, log }).catch((e) => log.warn(e.message));
  }
  cmdLoop().catch((e) => log.error('tg ' + e.message));
  await Promise.all([
    loop('discover', discoverTick),
    loop('maintain', maintainTick),
  ]);
}

process.on('uncaughtException', (e) => log.error('uncaught ' + e.message));
process.on('unhandledRejection', (e) => log.error('unhandled ' + (e?.message || e)));
main();
