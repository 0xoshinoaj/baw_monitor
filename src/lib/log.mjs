import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatTs } from './util.mjs';

/** RPC／節點雜訊：終端仍 WARN，不進 data/monitor.log。 */
const RPC_NOISE_RE = /RPC|eth_getLogs|eth_getBlock|節點失敗|\b429\b|冷卻|getLogs|尚未就緒|節點 chainId/;

export function isRpcLogNoise(msg) {
  return RPC_NOISE_RE.test(String(msg ?? ''));
}

export function stripAnsi(s) {
  return String(s ?? '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

export function createLogger({ file, timeZone = 'Asia/Taipei' } = {}) {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const write = (level, msg, opts = {}) => {
    const line = `[${formatTs(timeZone)}] ${level} ${msg}`;
    if (opts.console !== false) console.log(line);
    if (file && opts.file !== false && !isRpcLogNoise(msg)) {
      try { appendFileSync(file, stripAnsi(line) + '\n'); } catch { /* 日誌失敗不擋主路徑 */ }
    }
  };
  return {
    info: (m, opts) => write('INFO', m, opts),
    warn: (m, opts) => write('WARN', m, opts),
    error: (m, opts) => write('ERR ', m, opts),
  };
}
