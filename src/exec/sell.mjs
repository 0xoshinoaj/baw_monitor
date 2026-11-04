import { formatUnits, lc } from '../lib/util.mjs';
import { NATIVE_BNB, SEL } from '../lib/const.mjs';
import { inspectSimulation, previewUnsafeReason } from './preview.mjs';
import { quoteSellOnChain } from './bonding.mjs';
import { encAddr } from '../lib/util.mjs';

async function pollMarket(baw, orderId, log) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const r = await baw.marketList(orderId);
    const st = r.j?.data?.status || r.j?.data?.list?.[0]?.status;
    const row = r.j?.data?.list?.[0] || r.j?.data;
    if (st === 'FINISHED' || st === 'FAILED') return row;
    await new Promise((x) => setTimeout(x, 2000));
  }
  log?.warn(`market-order ${orderId} 仍在處理`);
  return { status: 'PENDING', orderId };
}

export async function sellMarket(baw, { token, amountHuman, log }) {
  const q = await baw.marketQuote({ fromTokenQty: amountHuman, fromToken: token, toToken: NATIVE_BNB });
  if (!q.j?.success) throw new Error('報價失敗 ' + (q.j?.error?.message || q.t).slice(0, 120));
  const s = await baw.marketSwap({ fromTokenQty: amountHuman, fromToken: token, toToken: NATIVE_BNB });
  if (!s.j?.success) throw new Error('送出失敗 ' + (s.j?.error?.message || s.t).slice(0, 120));
  const orderId = s.j.data?.orderId;
  const done = await pollMarket(baw, orderId, log);
  return { route: 'market-order', orderId, result: done };
}

export async function sellBonding({ rpc, baw, token, amountRaw, log }) {
  const q = await quoteSellOnChain(rpc, { token, wallet: baw.wallet.address, amountRaw });
  if (q.approveTx) {
    const ap = await baw.preview({ to: q.approveTx.to, value: '0', inputData: q.approveTx.inputData });
    const rid = ap.j?.data?.requestId;
    if (!rid) throw new Error('授權預演失敗');
    const chk = inspectSimulation({
      sim: ap.j.data.simulationResult,
      wallet: baw.wallet.address,
      expectedValueWei: 0n,
      payTokens: [NATIVE_BNB],
      allowApproveTo: [q.ctx.core],
    });
    // 授權交易本來就不會拿到代幣
    if (chk.codes.includes('EXTRA_APPROVAL') === false && chk.blocks.some((b) => b.code === 'UNEXPECTED_DEBIT')) {
      throw new Error('授權預演不安全：' + previewUnsafeReason(chk));
    }
    const ex = await baw.execute(rid);
    if (!ex.j?.success) throw new Error('授權失敗');
    await new Promise((x) => setTimeout(x, 6000));
  }
  const p = await baw.preview({ to: q.tx.to, value: '0', inputData: q.tx.inputData });
  const rid = p.j?.data?.requestId;
  if (!rid) throw new Error('賣出預演失敗 ' + (p.j?.error?.message || p.t).slice(0, 120));
  const chk = inspectSimulation({
    sim: p.j.data.simulationResult,
    wallet: baw.wallet.address,
    expectedValueWei: 0n,
    payTokens: [lc(token)],
    allowApproveTo: [q.ctx.core],
  });
  if (!chk.ok) throw new Error('賣出預演不安全：' + previewUnsafeReason(chk));
  const x = await baw.execute(rid);
  if (!x.j?.success) throw new Error('賣出失敗 ' + (x.j?.error?.message || '').slice(0, 120));
  log?.info(`[${baw.wallet.name}] bonding 賣出 ${token} tx=${x.j.data?.txHash || ''}`);
  return { route: 'contract-call', txHash: x.j.data?.txHash, sim: p.j.data.simulationResult };
}

export async function sellPosition({ rpc, baw, pos, amountRaw, reason, log }) {
  const token = pos.token;
  const decimals = pos.decimals || 18;
  const human = formatUnits(amountRaw, decimals);
  if (pos.stage === 'bonding') {
    return sellBonding({ rpc, baw, token, amountRaw, log });
  }
  return sellMarket(baw, { token, amountHuman: human, log });
}

export async function tokenBalance(rpc, token, wallet) {
  const r = await rpc.call(token, SEL.balanceOf + encAddr(wallet));
  return r && r.length >= 66 ? BigInt(r.slice(0, 66)) : 0n;
}
