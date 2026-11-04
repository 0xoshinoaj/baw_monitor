import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 同一工作區只允許一份主迴圈。 */
export function acquireLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    const old = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
    if (old && old !== process.pid) {
      try { process.kill(old, 0); console.error(`已經有一份在執行（PID ${old}）`); process.exit(0); } catch { /* 舊行程已死 */ }
    }
  } catch { /* 讀鎖失敗就覆寫 */ }
  writeFileSync(file, String(process.pid));
  const release = () => {
    try { if (Number(readFileSync(file, 'utf8')) === process.pid) unlinkSync(file); } catch { /* ignore */ }
  };
  process.on('exit', release);
  return release;
}
