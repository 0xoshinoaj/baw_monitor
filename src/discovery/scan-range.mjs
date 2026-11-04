/** BSC 出塊約 0.45s；每分鐘約 130 塊。用來把落後塊數換成秒。 */
export const BSC_BLOCK_MS = 450;

/** 約 12 分鐘。未超過就接著追塊，只有極端落後才跳。 */
export const DEFAULT_LAG_JUMP_BLOCKS = 1600;

/**
 * 規劃本輪要掃的區塊。
 * 落後未超過 lagJump 就從 cursor 接著掃（每輪最多 lookback 塊）；
 * 超過則跳到鏈頭附近，避免永遠追舊塊。
 * 第一次 cursor=0 只用 firstBlocks 小回看，不套 lagJump。
 */
export function planBlockRange({
  cursor = 0,
  head = 0,
  lookback = 64,
  lagJump = DEFAULT_LAG_JUMP_BLOCKS,
  firstBlocks = 16,
} = {}) {
  const h = Number(head) || 0;
  const lb = Math.max(1, Number(lookback) || 64);
  const jump = Math.max(lb, Number(lagJump) || DEFAULT_LAG_JUMP_BLOCKS);
  const cur = Number(cursor) || 0;
  if (h <= 0) return { from: 0, to: 0, head: 0, lag: 0, jumped: false, skipped: 0 };
  if (!cur) {
    const from = Math.max(0, h - Math.min(lb, firstBlocks));
    return { from, to: h, head: h, lag: h - from, jumped: false, skipped: 0 };
  }
  const lag = h - cur;
  if (lag <= 0) return { from: h + 1, to: h, head: h, lag: 0, jumped: false, skipped: 0 };
  if (lag > jump) {
    const from = Math.max(0, h - lb);
    return { from, to: h, head: h, lag, jumped: true, skipped: Math.max(0, from - cur - 1) };
  }
  const from = cur + 1;
  const to = Math.min(h, from + lb - 1);
  return { from, to, head: h, lag, jumped: false, skipped: 0 };
}

export function formatScanLag({ from, to, head, blockMs = BSC_BLOCK_MS } = {}) {
  const f = Number(from) || 0;
  const t = Number(to) || 0;
  const h = Number(head) || 0;
  const lag = Math.max(0, h - t);
  const sec = Math.round((lag * (Number(blockMs) || BSC_BLOCK_MS)) / 1000);
  return { lag, sec, text: `掃到區塊 ${f}-${t}，鏈頭 ${h}，落後 ${lag} 塊（約 ${sec} 秒）` };
}

export function formatHeatSummary({
  seen = 0,
  reached = 0,
  passed = 0,
  windowMs = 180_000,
  minWallets = 8,
} = {}) {
  return `熱度掃描：看到 ${seen} 個合約，達標 ${reached}，通過篩選 ${passed}（window=${windowMs}ms minWallets=${minWallets}）`;
}
