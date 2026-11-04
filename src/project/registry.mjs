import { lc, todayCompact } from '../lib/util.mjs';

const REF_ID_RE = /^(\d{8}#\d{5})/;
const NAME_MAX = 32;

export function emptyProject(address, source) {
  const now = Date.now();
  return {
    address: lc(address),
    sources: source ? [source] : [],
    firstSeenAt: now,
    updatedAt: now,
    symbol: '',
    name: '',
    kind: 'unknown',
    paid: false,
    isAgentIdExclusive: false,
    agentIdReason: '',
    progress: { pct: null, sold: null, cap: null, how: '', reliable: false },
    heat: { agentIdWallets: 0, txs: 0, windowMs: 0, updatedAt: 0 },
    deployer: '',
    tokenAddress: lc(address),
    risk: { flags: [], drain: false, serial: false, blacklist: false },
    mint: { adapter: '', to: '', data: '', valueWei: '0', perWalletCap: null, perTxCap: null },
    stage: 'unknown',
    status: 'watching',
    notified: {},
    walletState: {},
    ref: '',
    lastBlockReason: '',
    seenClosed: false,
    lastCheckedAt: 0,
  };
}

/** 每輪 maintain 大約抓這麼多筆。 */
export const MAINTAIN_BATCH_SIZE = 12;
/** 每輪至少留幾個舊項，避免新熱點把舊表完全擠掉。 */
export const MAINTAIN_OLD_RESERVE = 3;
/** 已印過「先追蹤」的舊項，至少隔這麼久才再 enrich（2–3 分鐘）。 */
export const MAINTAIN_OLD_COOLDOWN_MS = 150_000;
/** 從未檢查／剛 ingest 視為「本輪新的」的時間窗。 */
export const MAINTAIN_FRESH_MS = 60_000;
const HOT_INGEST_SOURCES = new Set(['heat', 'mintEvents', 'newContracts']);

function hasHotSource(project, sources = HOT_INGEST_SOURCES) {
  return (project?.sources || []).some((s) => sources.has(s));
}

/**
 * 新熱點：從未檢查的新項、本輪剛被 heat／mintEvents／newContracts ingest、或熱度剛更新。
 * 舊表裡從未檢查、但出現很久的項目不算新熱點，走舊項保留額。
 */
export function isFreshMaintainTarget(project, now = Date.now(), opts = {}) {
  if (!project) return false;
  if (opts.freshAddresses?.has(project.address)) return true;
  const lastCheck = project.lastCheckedAt || 0;
  const ingestedAt = project.updatedAt || 0;
  const heatAt = project.heat?.updatedAt || 0;
  const seenAt = project.firstSeenAt || ingestedAt;
  const freshMs = opts.freshMs ?? MAINTAIN_FRESH_MS;
  const hotSources = opts.hotSources ?? HOT_INGEST_SOURCES;

  if (!lastCheck && now - seenAt <= freshMs) return true;
  if (ingestedAt > lastCheck && hasHotSource(project, hotSources)) {
    if (lastCheck || now - ingestedAt <= freshMs) return true;
  }
  if (heatAt > lastCheck) {
    if (lastCheck || now - heatAt <= freshMs) return true;
  }
  return false;
}

function cmpAddr(a, b) {
  return String(a?.address || '').localeCompare(String(b?.address || ''));
}

function sortFresh(a, b) {
  const aNever = a.lastCheckedAt ? 0 : 1;
  const bNever = b.lastCheckedAt ? 0 : 1;
  if (aNever !== bNever) return bNever - aNever;
  const ah = a.heat?.updatedAt || 0;
  const bh = b.heat?.updatedAt || 0;
  if (ah !== bh) return bh - ah;
  const au = a.updatedAt || 0;
  const bu = b.updatedAt || 0;
  if (au !== bu) return bu - au;
  return cmpAddr(a, b);
}

function sortOld(a, b) {
  const ac = a.lastCheckedAt || 0;
  const bc = b.lastCheckedAt || 0;
  if (ac !== bc) return ac - bc;
  return cmpAddr(a, b);
}

/**
 * 抽出 maintain 排隊：新 ingest／熱度優先，舊項 2–3 分鐘降頻，每輪約 12 筆且保留 2–3 個舊項。
 * @param {object[]} projects
 * @param {{ now?: number, limit?: number, oldReserve?: number, oldCooldownMs?: number, freshMs?: number, freshAddresses?: Set<string> }} [opts]
 */
export function pickMaintainBatch(projects, opts = {}) {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? MAINTAIN_BATCH_SIZE;
  const oldReserve = opts.oldReserve ?? MAINTAIN_OLD_RESERVE;
  const oldCooldownMs = opts.oldCooldownMs ?? MAINTAIN_OLD_COOLDOWN_MS;
  const fresh = [];
  const oldReady = [];

  for (const p of projects || []) {
    if (!p) continue;
    if (isFreshMaintainTarget(p, now, opts)) {
      fresh.push(p);
      continue;
    }
    const lastCheck = p.lastCheckedAt || 0;
    if (lastCheck && now - lastCheck < oldCooldownMs) continue;
    oldReady.push(p);
  }

  fresh.sort(sortFresh);
  oldReady.sort(sortOld);

  const reserved = Math.min(oldReserve, oldReady.length);
  const picked = fresh.slice(0, Math.max(0, limit - reserved));
  picked.push(...oldReady.slice(0, reserved));
  if (picked.length < limit) {
    const used = new Set(picked);
    for (const p of fresh.concat(oldReady)) {
      if (picked.length >= limit) break;
      if (used.has(p)) continue;
      picked.push(p);
      used.add(p);
    }
  }
  return picked;
}

/** 0x + 前 4 + ... + 後 4，例如 0x813d...7953。 */
export function shortContract(addr) {
  const a = String(addr || '');
  if (a.length >= 12 && /^0x[0-9a-fA-F]+$/i.test(a)) return `0x${a.slice(2, 6)}...${a.slice(-4)}`;
  return a || 'unknown';
}

export function projectLabel(project) {
  const raw = String(project?.symbol || project?.name || '').trim();
  const cleaned = raw.replace(/[\r\n#\u0000-\u001f]+/g, '').replace(/\s+/g, '').slice(0, NAME_MAX);
  if (cleaned) return cleaned;
  return shortContract(project?.address);
}

export function projectRefId(project) {
  const m = String(project?.ref || '').match(REF_ID_RE);
  return m ? m[1] : '';
}

export function formatProjectRef(project) {
  if (!project) return '';
  const id = projectRefId(project);
  const name = projectLabel(project);
  return id ? `${id}-${name}` : name;
}

export function nextRefId(store, { timeZone = 'Asia/Taipei', day } = {}) {
  const d = day || todayCompact(timeZone);
  const seq = store.data.seq || (store.data.seq = { day: '', n: 0 });
  if (seq.day !== d) {
    seq.day = d;
    seq.n = 0;
  }
  seq.n += 1;
  store.mark();
  return `${d}#${String(seq.n).padStart(5, '0')}`;
}

/** 同一合約只發一次編號；舊項目沒編號則用當天序號補發。名稱變了只改後綴。 */
export function ensureProjectRef(store, project, opts = {}) {
  if (!project) return '';
  const existing = projectRefId(project);
  const id = existing || nextRefId(store, opts);
  project.ref = `${id}-${projectLabel(project)}`;
  store.mark();
  return project.ref;
}

export function onceNotified(project, key, now = Date.now()) {
  if (!project.notified) project.notified = {};
  if (project.notified[key]) return false;
  project.notified[key] = now;
  return true;
}

export function shouldLogBlockReason(project, reason) {
  const r = String(reason || '');
  if (!r) return false;
  if (project.lastBlockReason === r) return false;
  project.lastBlockReason = r;
  return true;
}

export function createRegistry(store, opts = {}) {
  const options = { timeZone: opts.timeZone || 'Asia/Taipei', day: opts.day };
  const items = () => store.data.items;

  function get(addr) {
    return items()[lc(addr)] || null;
  }

  function refreshRef(p) {
    if (!p) return null;
    ensureProjectRef(store, p, options);
    return p;
  }

  function upsertCandidate(cand) {
    const addr = lc(cand.address);
    if (!addr) return null;
    let p = items()[addr];
    if (!p) {
      p = emptyProject(addr, cand.source);
      items()[addr] = p;
    } else if (cand.source && !p.sources.includes(cand.source)) {
      p.sources.push(cand.source);
    }
    p.updatedAt = Date.now();
    if (cand.extra?.symbol && !p.symbol) p.symbol = cand.extra.symbol;
    if (cand.extra?.name && !p.name) p.name = cand.extra.name;
    if (cand.extra?.progress != null && p.progress.pct == null) {
      p.progress = { ...p.progress, pct: Number(cand.extra.progress), how: cand.extra.progressHow || 'memeRush', reliable: cand.extra.progressReliable !== false };
    }
    if (cand.extra?.stage) p.stage = cand.extra.stage;
    if (cand.extra?.kind) p.kind = cand.extra.kind;
    if (cand.extra?.paid != null) p.paid = !!cand.extra.paid;
    if (cand.extra?.isAgentIdExclusive) p.isAgentIdExclusive = true;
    if (cand.extra?.heat) {
      p.heat = { ...p.heat, ...cand.extra.heat, updatedAt: Date.now() };
    }
    ensureProjectRef(store, p, options);
    store.mark();
    return p;
  }

  /** 登錄候選。同一合約只發一次編號、只標一次 discovered。 */
  function ingest(cand) {
    const created = !!lc(cand.address) && !get(cand.address);
    const project = upsertCandidate(cand);
    const discovered = !!(created && project && onceNotified(project, 'discovered'));
    if (discovered) store.mark();
    return { project, created, discovered };
  }

  function patch(addr, fn) {
    const p = get(addr);
    if (!p) return null;
    fn(p);
    p.updatedAt = Date.now();
    ensureProjectRef(store, p, options);
    store.mark();
    return p;
  }

  function watching() {
    return Object.values(items()).filter((p) => !['sold', 'ignored'].includes(p.status));
  }

  function list() {
    return Object.values(items());
  }

  return { get, upsertCandidate, ingest, patch, refreshRef, watching, list, items };
}
