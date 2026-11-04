import { NATIVE_BNB, USDT } from '../lib/const.mjs';
import { agentIdTokenId } from '../lib/keccak.mjs';
import { weiToBnb } from '../lib/util.mjs';
import { formatProjectRef } from '../project/registry.mjs';
import { inspectSimulation, previewUnsafeReason, receivedErc20, spentUsdEstimate } from './preview.mjs';
import { resolveBuyTx } from './bonding.mjs';
import { fitShares, learnReplay, replaceDeadline, rewriteReplayCalldata } from './replay.mjs';
import { probeFreeMint } from '../classify/mint-kind.mjs';

const queues = new Map();
const inflight = new Set();

export function enqueueWallet(name, fn) {
  const prev = queues.get(name) || Promise.resolve();
  const job = prev.then(fn, fn);
  queues.set(name, job.catch(() => {}));
  return job;
}

export function inflightCount() {
  return inflight.size;
}

async function previewThenExecute(baw, { to, value, inputData, check }) {
  const p = await baw.preview({ to, value: String(value), inputData });
  const sim = p.j?.data?.simulationResult;
  const rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) {
    throw new Error('預演失敗 ' + (p.j?.error?.message || p.t).slice(0, 160));
  }
  const verdict = check(sim);
  if (!verdict.ok) throw new Error('預演不安全：' + previewUnsafeReason(verdict));
  inflight.add(rid);
  try {
    const x = await baw.execute(rid);
    if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) {
      throw new Error('結果不明：送出逾時，可能已上鏈，先不重打');
    }
    if (!x.j?.success) throw new Error('送出失敗 ' + (x.j?.error?.message || x.t).slice(0, 160));
    return { txHash: x.j.data?.txHash || '', status: x.j.data?.status, orderId: x.j.data?.orderId, sim };
  } finally {
    inflight.delete(rid);
  }
}

export async function drainCheck(rpc, addr, valueWei) {
  if (!(BigInt(valueWei || 0) > 0n)) return '';
  const bal = Number(await rpc.getBalance(addr)) / 1e18;
  if (bal < 0.01) return `合約裡只剩 ${bal.toFixed(4)} BNB，付的錢可能已被抽走`;
  return '';
}

async function planMint(rpc, cfg, project, wallet) {
  if (project.kind === 'bonding' || project.stage === 'bonding') {
    const q = await resolveBuyTx(rpc, cfg, { token: project.tokenAddress || project.address, wallet: wallet.address });
    return {
      adapter: 'bonding',
      to: q.tx.to,
      data: q.tx.inputData,
      valueWei: BigInt(q.tx.value || 0),
      allowApproveTo: [q.tx.to],
      payTokens: [NATIVE_BNB],
      replayForeignUnresolved: false,
    };
  }

  const code = await rpc.getCode(project.address);
  const free = await probeFreeMint(rpc, wallet.address, project.address, code);
  if (free && (project.kind === 'free' || project.kind === 'unknown')) {
    return {
      adapter: 'typed-free',
      to: project.address,
      data: free.data,
      valueWei: 0n,
      allowApproveTo: [],
      payTokens: [NATIVE_BNB],
      replayForeignUnresolved: false,
    };
  }

  const learned = await learnReplay(rpc, project.address);
  if (!learned) throw new Error('沒有可用的 typed / replay 鑄造計畫');
  let data = replaceDeadline(learned.data);
  const rw = await rewriteReplayCalldata(rpc, {
    data,
    valueWei: learned.valueWei,
    wallet: wallet.address,
    to: project.address,
    agentId: agentIdTokenId(wallet.name),
  });
  if (rw.foreignUnresolved) {
    return { adapter: 'replay', to: project.address, data: rw.data, valueWei: learned.valueWei, replayForeignUnresolved: true, allowApproveTo: [], payTokens: [NATIVE_BNB, USDT] };
  }
  const fitted = await fitShares(rpc, { data: rw.data, valueWei: learned.valueWei, from: wallet.address, to: project.address });
  return {
    adapter: 'replay',
    to: project.address,
    data: fitted.data,
    valueWei: fitted.valueWei,
    allowApproveTo: [],
    payTokens: [NATIVE_BNB, USDT],
    replayForeignUnresolved: false,
  };
}

export async function mintOne({ rpc, baw, cfg, project, log, bnbUsd }) {
  const wallet = baw.wallet;
  const keep = cfg.budget.keepBnb;
  const bal = Number(await rpc.getBalance(wallet.address)) / 1e18;
  const plan = await planMint(rpc, cfg, project, wallet);
  const needBnb = weiToBnb(plan.valueWei);
  if (bal < needBnb + keep) throw new Error(`BNB 不足：餘額 ${bal.toFixed(4)}，需要 ${needBnb} + 保留 ${keep}`);

  const drain = await drainCheck(rpc, plan.to, plan.valueWei);
  if (drain) throw Object.assign(new Error(drain), { block: true, drain: true });

  const result = await previewThenExecute(baw, {
    to: plan.to,
    value: plan.valueWei.toString(),
    inputData: plan.data,
    check: (sim) => inspectSimulation({
      sim,
      wallet: wallet.address,
      expectedValueWei: plan.valueWei,
      payTokens: plan.payTokens,
      allowApproveTo: plan.allowApproveTo,
      replayForeignUnresolved: plan.replayForeignUnresolved,
    }),
  });

  const tokens = receivedErc20(result.sim, wallet.address);
  const costUsd = spentUsdEstimate(result.sim, wallet.address, bnbUsd);
  log?.info(`[${wallet.name}] 已鑄造 ${formatProjectRef(project)} tx=${result.txHash} 成本約 ${costUsd.toFixed(2)}U adapter=${plan.adapter}`);
  return { ...result, tokens, costUsd, adapter: plan.adapter, valueWei: plan.valueWei.toString() };
}
