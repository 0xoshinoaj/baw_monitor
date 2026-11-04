import { EVENT_TYPES } from '../lib/const.mjs';
import { event } from '../notify/events.mjs';
import { weiToBnb } from '../lib/util.mjs';

export async function refreshSession({ baw, rpc, session, cfg, emit, log }) {
  const w = baw.wallet;
  const rec = session.data.wallets[w.name] || {};
  const st = await baw.status();
  rec.status = st.j?.data?.status || 'UNKNOWN';
  rec.checkedAt = Date.now();
  if (rec.status !== 'CONNECTED') {
    if (Date.now() - (rec.loginAlertAt || 0) > 30 * 60_000) {
      rec.loginAlertAt = Date.now();
      await emit(event(EVENT_TYPES.SESSION_LOGIN, {
        title: `[${w.name}] 尚未登入或已過期`,
        lines: [`status=${rec.status}`, '請重新執行 npm start 以登入（或 node login.mjs）'],
      }));
    }
    session.data.wallets[w.name] = rec;
    session.mark();
    return rec;
  }

  const settings = await baw.settings();
  const dev = settings.j?.data?.devMode || {};
  rec.devMode = !!dev.enabled;
  rec.devExpiresAt = dev.expiresAt || '';
  rec.dailyLimit = dev.dailyLimit;
  rec.quotaUsed = settings.j?.data?.developerModeQuotaUsed;
  const expired = rec.devExpiresAt && Number(rec.devExpiresAt) < Date.now();
  if (!rec.devMode || expired) {
    if (Date.now() - (rec.devAlertAt || 0) > 30 * 60_000) {
      rec.devAlertAt = Date.now();
      await emit(event(EVENT_TYPES.SESSION_DEVMODE, {
        title: `[${w.name}] 開發者模式未開或已過期`,
        lines: ['內盤／contract-call 需要開發者模式', '幣安 App → Agentic Wallet → 設定 → Developer Mode'],
      }));
    }
  }

  const ag = await baw.agentId();
  rec.agentIdClaimed = !!ag.j?.data?.claimed;
  rec.agentDomain = ag.j?.data?.domain || w.name;

  const bal = await rpc.getBalance(w.address);
  rec.bnb = weiToBnb(bal);
  if (rec.bnb < cfg.budget.keepBnb + 0.02 && Date.now() - (rec.lowBnbAt || 0) > 6 * 3600_000) {
    rec.lowBnbAt = Date.now();
    await emit(event(EVENT_TYPES.SESSION_LOW_BNB, {
      title: `[${w.name}] BNB 快不夠`,
      lines: [`剩 ${rec.bnb.toFixed(4)} BNB，保留 gas=${cfg.budget.keepBnb}`],
    }));
  }
  session.data.wallets[w.name] = rec;
  session.mark();
  log?.info(`[${w.name}] session ${rec.status} dev=${rec.devMode} agentId=${rec.agentIdClaimed} bnb=${rec.bnb.toFixed(4)}`);
  return rec;
}
