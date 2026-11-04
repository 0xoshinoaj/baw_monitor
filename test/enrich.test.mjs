import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAT_FRESH_MS, HEAT_LOOKBACK_BLOCKS, heatIsFresh, recipientsFromMintLogs } from '../src/classify/heat.mjs';
import { TOPIC_TRANSFER, ZERO } from '../src/lib/const.mjs';
import { padTopicAddress } from '../src/lib/util.mjs';
import { emptyProject } from '../src/project/registry.mjs';
import { enrichProject, refreshAgentIdWallets } from '../src/project/enrich.mjs';

const CONTRACT = '0xcccccccccccccccccccccccccccccccccccccccc';
const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WALLET_C = '0x1111111111111111111111111111111111111111';
const WALLET_D = '0x2222222222222222222222222222222222222222';
const WALLET_E = '0x3333333333333333333333333333333333333333';

function topicAddr(addr) {
  return padTopicAddress(addr);
}

function mintLog(to) {
  return { topics: [TOPIC_TRANSFER, topicAddr(ZERO), topicAddr(to)] };
}

function hexWord(n) {
  return '0x' + BigInt(n).toString(16).padStart(64, '0');
}

function mockRpc({ head = 10_000, logs = [], holders = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    getCode: async () => '0x',
    rpc: async () => hexWord(0),
    call: async () => null,
    multicall: async () => [null, null],
    blockNumber: async () => {
      calls.push({ method: 'blockNumber' });
      return head;
    },
    getLogs: async (filter) => {
      calls.push({ method: 'getLogs', filter });
      return logs;
    },
    getMintLogs: async () => {
      calls.push({ method: 'getMintLogs' });
      throw new Error('不應打鑄造事件 logs 池');
    },
    rpcBatch: async (reqs) => {
      calls.push({ method: 'rpcBatch', n: reqs.length });
      return reqs.map((req) => {
        const addr = ('0x' + String(req.params?.[0]?.data || '').slice(-40)).toLowerCase();
        return hexWord(holders.has(addr) ? 1 : 0);
      });
    },
  };
}

function riskStore() {
  return { data: { fingerprints: {}, deployers: {}, blacklist: [] } };
}

const cfg = { thresholds: { serialDeployMax: 99, serialDevMax: 99 } };

test('熱度夠新才沿用', () => {
  const now = 1_000_000;
  assert.equal(heatIsFresh({ updatedAt: 0 }, now), false);
  assert.equal(heatIsFresh({ updatedAt: now - HEAT_FRESH_MS }, now), false);
  assert.equal(heatIsFresh({ updatedAt: now - HEAT_FRESH_MS + 1 }, now), true);
  assert.equal(heatIsFresh(null, now), false);
});

test('mint log 抽出收款地址、略過零地址與缺 topic', () => {
  const tos = recipientsFromMintLogs([
    mintLog(WALLET_A),
    mintLog(WALLET_A),
    mintLog(ZERO),
    { topics: [TOPIC_TRANSFER] },
    mintLog(WALLET_B),
  ]);
  assert.deepEqual(tos, [WALLET_A, WALLET_A, WALLET_B]);
});

test('熱度過期：有地址 getLogs + holdsAgentIdBatch 寫回錢包數', async () => {
  const rpc = mockRpc({
    head: 10_000,
    logs: [mintLog(WALLET_A), mintLog(WALLET_B), mintLog(WALLET_C), mintLog(WALLET_A)],
    holders: new Set([WALLET_A, WALLET_C]),
  });
  const project = emptyProject(CONTRACT);
  await refreshAgentIdWallets(rpc, project);

  const getLogs = rpc.calls.filter((c) => c.method === 'getLogs');
  assert.equal(getLogs.length, 1);
  assert.equal(getLogs[0].filter.address, CONTRACT);
  assert.equal(getLogs[0].filter.fromBlock, '0x' + (10_000 - HEAT_LOOKBACK_BLOCKS).toString(16));
  assert.equal(getLogs[0].filter.toBlock, '0x' + (10_000).toString(16));
  assert.deepEqual(getLogs[0].filter.topics, [TOPIC_TRANSFER, padTopicAddress(ZERO)]);
  assert.equal(rpc.calls.some((c) => c.method === 'getMintLogs'), false);
  assert.equal(project.heat.agentIdWallets, 2);
  assert.equal(project.heat.txs, 4);
  assert.ok(project.heat.updatedAt > 0);
});

test('熱度夠新就沿用，不打 getLogs', async () => {
  const rpc = mockRpc({ logs: [mintLog(WALLET_A)] });
  const project = emptyProject(CONTRACT);
  project.heat = { agentIdWallets: 42, txs: 50, windowMs: 180_000, updatedAt: Date.now() };
  await refreshAgentIdWallets(rpc, project);
  assert.equal(rpc.calls.some((c) => c.method === 'getLogs'), false);
  assert.equal(rpc.calls.some((c) => c.method === 'rpcBatch'), false);
  assert.equal(project.heat.agentIdWallets, 42);
});

test('getLogs 失敗沿用舊數字、不丟例外', async () => {
  const rpc = mockRpc();
  rpc.getLogs = async () => { throw new Error('limit exceeded'); };
  const project = emptyProject(CONTRACT);
  project.heat = { agentIdWallets: 7, txs: 9, windowMs: 0, updatedAt: 1 };
  await refreshAgentIdWallets(rpc, project);
  assert.equal(project.heat.agentIdWallets, 7);
  assert.equal(project.heat.updatedAt, 1);
});

test('enrichProject 會補過期項目的 agentIdWallets，且不走 logs 池', async () => {
  const rpc = mockRpc({
    logs: [mintLog(WALLET_D), mintLog(WALLET_E)],
    holders: new Set([WALLET_D, WALLET_E]),
  });
  const project = emptyProject(CONTRACT);
  await enrichProject(rpc, project, cfg, riskStore());
  assert.equal(project.heat.agentIdWallets, 2);
  assert.equal(rpc.calls.some((c) => c.method === 'getMintLogs'), false);
  const getLogs = rpc.calls.find((c) => c.method === 'getLogs');
  assert.ok(getLogs?.filter?.address);
});
