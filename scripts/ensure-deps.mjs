#!/usr/bin/env node
/**
 * Fail fast with a clear message when node_modules was never installed.
 * GitHub / VPS clones do not include node_modules (.gitignore).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const marker = join(root, 'node_modules', 'smol-toml');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!existsSync(marker)) {
  fail(
    [
      '找不到套件：smol-toml（node_modules 尚未安裝）。',
      '這個 repo 不提交 node_modules；clone / pull 之後請先執行：',
      '',
      '  npm ci',
      '',
      '沒有 package-lock 時再用：npm install',
      '然後再 npm start。',
    ].join('\n'),
  );
}

try {
  createRequire(join(root, 'package.json'))('smol-toml');
} catch (e) {
  fail(
    [
      `依賴損壞或未裝齊：${e?.message || e}`,
      '請在專案根目錄重裝：',
      '',
      '  rm -rf node_modules && npm ci',
    ].join('\n'),
  );
}
