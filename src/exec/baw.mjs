import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../config.mjs';
import { BINANCE_CHAIN_ID, NATIVE_BNB } from '../lib/const.mjs';
import { safeJson } from '../lib/util.mjs';

function runFile(file, args, env, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const t = String(stdout || stderr || err?.message || '');
      resolve({ t, j: safeJson(t), err });
    });
  });
}

export function createBawClient(wallet, log) {
  const env = { ...process.env };
  let file = 'baw';
  let prefix = [];
  if (wallet.bawDir) {
    env.BINANCE_BAW_DIR = join(ROOT, wallet.bawDir);
    env.BINANCE_INSTANCE_ID = wallet.instanceId || wallet.name;
    file = process.execPath;
    prefix = [join(ROOT, wallet.bawPkg || 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js')];
  }

  async function run(args, timeout = 60_000) {
    const all = wallet.bawDir
      ? [...prefix, ...args, '--json']
      : [...args, '--json'];
    const r = wallet.bawDir
      ? await runFile(file, all, env, timeout)
      : await runFile('baw', all, env, timeout);
    return r;
  }

  return {
    wallet,
    run,
    status: () => run(['wallet', 'status']),
    address: () => run(['wallet', 'address']),
    settings: () => run(['wallet', 'settings']),
    agentId: () => run(['wallet', 'agent-id']),
    balance: (token) => {
      const args = ['wallet', 'balance', '--binanceChainId', BINANCE_CHAIN_ID];
      if (token) args.push('--tokenAddress', token);
      return run(args);
    },
    signin: () => run(['auth', 'signin']),
    verify: (qrCodeId) => run(['auth', 'verify', '--qrCodeId', qrCodeId], 330_000),
    txHistory: (type) => {
      const args = ['wallet', 'tx-history', '--binanceChainId', BINANCE_CHAIN_ID];
      if (type) args.push('--type', type);
      return run(args);
    },
    preview({ to, value = '0', inputData = '0x' }) {
      return run([
        'contract-call', 'preview',
        '--binanceChainId', BINANCE_CHAIN_ID,
        '--from', wallet.address,
        '--to', to,
        '--value', String(value),
        '--inputData', inputData,
      ], 90_000);
    },
    execute(requestId) {
      return run(['contract-call', 'execute', '--requestId', requestId], 90_000);
    },
    marketQuote({ fromTokenQty, fromToken = NATIVE_BNB, toToken }) {
      return run([
        'market-order', 'quote',
        '--fromTokenQty', String(fromTokenQty),
        '--fromToken', fromToken,
        '--toToken', toToken,
        '--binanceChainId', BINANCE_CHAIN_ID,
      ]);
    },
    marketSwap({ fromTokenQty, fromToken = NATIVE_BNB, toToken, slippage }) {
      const args = [
        'market-order', 'swap',
        '--fromTokenQty', String(fromTokenQty),
        '--fromToken', fromToken,
        '--toToken', toToken,
        '--binanceChainId', BINANCE_CHAIN_ID,
      ];
      if (slippage != null) args.push('--slippage', String(slippage));
      return run(args, 90_000);
    },
    marketList(orderId) {
      return run(['market-order', 'list', '--orderId', orderId]);
    },
    async requireConnected() {
      const s = await this.status();
      const st = s.j?.data?.status;
      if (st !== 'CONNECTED') {
        log?.warn(`[${wallet.name}] 尚未登入（status=${st || 'unknown'}），請重新執行 npm start`);
        return false;
      }
      return true;
    },
  };
}

export function createBawClients(cfg, log) {
  return cfg.wallets.map((w) => createBawClient(w, log));
}
