import { join } from 'node:path';
import { DATA_DIR } from '../config.mjs';
import { todayKey } from '../lib/util.mjs';
import { createJsonStore } from './json-store.mjs';

export function openStores() {
  const projects = createJsonStore(join(DATA_DIR, 'projects.json'), { items: {}, seq: { day: '', n: 0 } });
  const positions = createJsonStore(join(DATA_DIR, 'positions.json'), { items: [] });
  const risk = createJsonStore(join(DATA_DIR, 'risk.json'), {
    day: '',
    spendUsd: {},
    mints: {},
    blacklist: [],
    deployers: {},
    fingerprints: {},
    trades: [],
    stats: { freeMints: 0, paidMints: 0, sells: 0, sellUsd: 0 },
  });
  const session = createJsonStore(join(DATA_DIR, 'session.json'), {
    wallets: {},
    tgOffset: 0,
    lastLoopAt: 0,
    scanCursor: 0,
    pendingConfirm: {},
  });
  return { projects, positions, risk, session };
}

export function rolloverDay(riskStore, timeZone) {
  const day = todayKey(timeZone);
  if (riskStore.data.day !== day) {
    riskStore.data.day = day;
    riskStore.data.spendUsd = {};
    riskStore.data.mints = {};
    riskStore.mark();
  }
  return riskStore.data;
}

export function saveAll(stores) {
  for (const s of Object.values(stores)) s.save();
}
