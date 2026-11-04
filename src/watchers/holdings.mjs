import { EVENT_TYPES, PCS_FACTORY, PCS_ROUTER, SEL, WBNB } from '../lib/const.mjs';
import { encAddr, encUint, firstWord, wordAddr } from '../lib/util.mjs';
import { event } from '../notify/events.mjs';
import { decideSell, normalizeSellDecision } from '../policy/sell.mjs';
import { sellPosition, tokenBalance } from '../exec/sell.mjs';

function posId(token, wallet) {
  return `${token}:${wallet}`;
}

export function upsertPosition(positions, row) {
  const id = posId(row.token, row.wallet);
  const list = positions.data.items;
  let p = list.find((x) => x.id === id);
  if (!p) {
    p = {
      id,
      token: row.token,
      wallet: row.wallet,
      walletName: row.walletName,
      symbol: row.symbol || row.token.slice(0, 8),
      project: row.project || row.token,
      costUsd: row.costUsd || 0,
      paid: !!row.paid,
      hold: !!row.hold,
      boughtAt: Date.now(),
      openAt: null,
      basePx: 0,
      peakPx: 0,
      notified: [],
      doneSteps: [],
      backDone: false,
      stage: row.stage || 'unknown',
      decimals: row.decimals || 18,
      soldAt: null,
    };
    list.push(p);
  } else {
    if (row.costUsd) p.costUsd = Number(row.costUsd);
    if (row.symbol) p.symbol = row.symbol;
    if (row.stage) p.stage = row.stage;
  }
  positions.mark();
  return p;
}

export function seedConfigTokens(positions, cfg) {
  for (const t of cfg.tokens || []) {
    const wallets = t.both || !t.only ? cfg.wallets : cfg.wallets.filter((w) => w.address === t.only);
    for (const w of wallets) {
      upsertPosition(positions, {
        token: t.addr,
        wallet: w.address,
        walletName: w.name,
        symbol: t.sym || t.symbol,
        costUsd: t.cost || 0,
        paid: (t.cost || 0) > 0,
        hold: !!t.hold,
      });
    }
  }
}

async function pairPx(rpc, token) {
  try {
    const pair = await rpc.call(PCS_FACTORY, SEL.getPair + encAddr(token) + encAddr(WBNB));
    if (!pair || firstWord(pair) === 0n) return { px: 0, pair: '' };
    const pairAddr = wordAddr(firstWord(pair));
    const one = 10n ** 18n;
    const out = await rpc.call(PCS_ROUTER, SEL.getAmountsOut + encUint(one) + encUint(64) + encUint(2) + encAddr(token) + encAddr(WBNB));
    if (!out || out.length < 2 + 64 * 4) return { px: 0, pair: pairAddr };
    const bnb = Number(BigInt('0x' + out.slice(2 + 64 * 3, 2 + 64 * 4))) / 1e18;
    return { px: bnb, pair: pairAddr };
  } catch {
    return { px: 0, pair: '' };
  }
}

export async function checkHoldings({ rpc, baws, positions, risk, cfg, emit, log, bnbUsd }) {
  const byWallet = new Map(baws.map((b) => [b.wallet.address, b]));
  for (const pos of positions.data.items) {
    if (pos.soldAt) continue;
    const baw = byWallet.get(pos.wallet);
    if (!baw) continue;
    const bal = await tokenBalance(rpc, pos.token, pos.wallet).catch(() => 0n);
    if (bal === 0n) continue;
    const { px, pair } = await pairPx(rpc, pos.token);
    if (pair && !pos.openAt) {
      pos.openAt = Date.now();
      if (!pos.basePx) pos.basePx = px;
      positions.mark();
      await emit(event(EVENT_TYPES.POSITION_OPEN, {
        title: `${pos.symbol} 已開池`,
        lines: [`合約 ${pos.token}`, `錢包 ${pos.walletName}`],
        address: pos.token,
      }));
    }
    if (!(px > 0)) continue;
    pos.peakPx = Math.max(pos.peakPx || 0, px);
    const valueUsd = (Number(bal) / 10 ** (pos.decimals || 18)) * px * (bnbUsd || 0);
    let d = decideSell({
      paid: pos.paid,
      hold: pos.hold,
      costUsd: pos.costUsd,
      valueUsd,
      px,
      peakPx: pos.peakPx,
      basePx: pos.basePx || px,
      backDone: pos.backDone,
      doneSteps: pos.doneSteps,
      notified: pos.notified,
      rules: cfg.sell,
    });
    d = normalizeSellDecision(d, cfg.sell);
    if (d.action === 'notify' && d.notifyX) {
      pos.notified.push(d.tag || d.notifyX);
      positions.mark();
      await emit(event(EVENT_TYPES.POSITION_MULTIPLE, {
        title: `[${pos.walletName}] ${pos.symbol} 到 ${d.notifyX} 倍`,
        lines: d.reasons.concat([`現值約 ${valueUsd.toFixed(2)}U`, pos.token]),
        address: pos.token,
      }));
    }
    if (d.action === 'sell' && d.sellPct > 0) {
      const amt = (bal * BigInt(Math.round(d.sellPct))) / 100n;
      if (amt <= 0n) continue;
      try {
        const r = await sellPosition({ rpc, baw, pos, amountRaw: amt, reason: d.reasons[0], log });
        if (d.tag === 'back') pos.backDone = true;
        if (d.tag) pos.doneSteps.push(d.tag);
        if (d.sellPct >= 100) pos.soldAt = Date.now();
        risk.data.stats.sells = (risk.data.stats.sells || 0) + 1;
        risk.data.stats.sellUsd = (risk.data.stats.sellUsd || 0) + valueUsd * (d.sellPct / 100);
        risk.data.trades.push({ at: Date.now(), sym: pos.symbol, usd: valueUsd * (d.sellPct / 100), kind: 'sell', wallet: pos.walletName });
        risk.mark();
        positions.mark();
        await emit(event(EVENT_TYPES.SELL_EXECUTED, {
          title: `[${pos.walletName}] 賣出 ${pos.symbol} ${d.sellPct}%`,
          lines: d.reasons.concat([`tx/order ${r.txHash || r.orderId || ''}`, pos.token]),
          address: pos.token,
        }));
      } catch (e) {
        await emit(event(EVENT_TYPES.SELL_FAILED, {
          title: `[${pos.walletName}] 賣出失敗 ${pos.symbol}`,
          lines: [e.message, pos.token],
          address: pos.token,
        }));
      }
    }
  }
}

export function statsFromStores(positions, risk, cfg) {
  const open = positions.data.items.filter((p) => !p.soldAt);
  const sold = positions.data.items.filter((p) => p.soldAt);
  return {
    freeMints: risk.data.stats.freeMints || 0,
    paidMints: risk.data.stats.paidMints || 0,
    sells: risk.data.stats.sells || 0,
    sellUsd: risk.data.stats.sellUsd || 0,
    open: open.length,
    sold: sold.length,
    trades: risk.data.trades.slice(-20),
    wallets: cfg.wallets.map((w) => w.name),
  };
}

export function formatHoldings(positions) {
  const rows = positions.data.items.filter((p) => !p.soldAt);
  if (!rows.length) return ['目前沒有持倉'];
  return rows.map((p) => `· ${p.symbol} ${p.walletName} 成本 ${p.costUsd}U ${p.paid ? '付費' : '免費'} ${p.token}`);
}
