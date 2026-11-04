#!/usr/bin/env node
// 登入 config.toml 裡第 N 個錢包（預設第 1 個）：node login.mjs 2
// 主路徑請直接 npm start（會檢測並登入）。此腳本保留給手動重登。
// 印出官方登入連結，用該錢包的幣安 App 確認（約 5 分鐘內有效）。
import { loadConfig } from './src/config.mjs';
import { createBawClient } from './src/exec/baw.mjs';
import { runLogin } from './src/setup/bootstrap.mjs';

const cfg = loadConfig();
const idx = (Number(process.argv[2]) || 1) - 1;
const wc = cfg.wallets[idx];
if (!wc) {
  console.error('找不到這個錢包');
  process.exit(1);
}
const baw = createBawClient(wc);
const ok = await runLogin(baw);
process.exit(ok ? 0 : 1);
