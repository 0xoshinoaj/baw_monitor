import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadAddress, CallReverted, createRpc } from '../src/chain/rpc.mjs';
import { DEFAULT_LOGS_RPCS, DEFAULT_RECEIPT_RPCS, DEFAULT_RPCS, TOPIC_TRANSFER, ZERO } from '../src/lib/const.mjs';
import { padTopicAddress } from '../src/lib/util.mjs';
import { resolveImpl } from '../src/chain/code.mjs';

const ADDR = '0x1111111111111111111111111111111111111111';
const SHORT = '0x11111111111111111111111111111111111111'; // 38 hex

function mockFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return handler(url, init, calls);
  };
  return {
    calls,
    restore() { globalThis.fetch = orig; },
  };
}

function jsonError(message) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { message } }) };
}

function jsonResult(result) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
}

function fakeResolveRpc() {
  const calls = [];
  return {
    calls,
    getCode: async (to) => {
      calls.push({ method: 'getCode', to });
      return '0x';
    },
    rpc: async (method) => {
      calls.push({ method });
      return '0x' + '0'.repeat(64);
    },
    call: async (to, data) => {
      calls.push({ method: 'call', to, data });
      return null;
    },
  };
}

describe('rpc 預期失敗安靜略過', { concurrency: 1 }, () => {
  test('execution reverted 不寫 warn、不冷卻、不換節點重試', async () => {
    const mock = mockFetch(() => jsonError('execution reverted: 0x'));
    const warns = [];
    const rpc = createRpc(['https://a.example/rpc', 'https://b.example/rpc'], { warn: (m) => warns.push(m) });
    try {
      await assert.rejects(
        () => rpc.call(ADDR, '0x12345678'),
        (e) => e instanceof CallReverted,
      );
      assert.equal(mock.calls.length, 1);
      assert.equal(warns.length, 0);
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0 && n.fails === 0));
    } finally {
      mock.restore();
    }
  });

  test('hex string has length 38 不寫 warn、不冷卻、不換節點重試', async () => {
    const mock = mockFetch(() => jsonError('invalid argument 0: hex string has length 38, want 40 for common.Address'));
    const warns = [];
    const rpc = createRpc(['https://a.example/rpc', 'https://b.example/rpc'], { warn: (m) => warns.push(m) });
    try {
      await assert.rejects(
        () => rpc.rpc('eth_call', [{ to: SHORT, data: '0x12345678' }, 'latest']),
        (e) => e instanceof BadAddress,
      );
      assert.equal(mock.calls.length, 1);
      assert.equal(warns.length, 0);
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0 && n.fails === 0));
    } finally {
      mock.restore();
    }
  });

  test('Invalid params 不寫 warn、不冷卻', async () => {
    const mock = mockFetch(() => jsonError('Invalid params'));
    const warns = [];
    const rpc = createRpc(['https://a.example/rpc', 'https://b.example/rpc'], { warn: (m) => warns.push(m) });
    try {
      await assert.rejects(
        () => rpc.call(ADDR, '0x12345678'),
        (e) => e instanceof CallReverted,
      );
      assert.equal(mock.calls.length, 1);
      assert.equal(warns.length, 0);
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0 && n.fails === 0));
    } finally {
      mock.restore();
    }
  });

  test('非法 to 不發 fetch', async () => {
    const mock = mockFetch(() => jsonResult('0x'));
    const warns = [];
    const rpc = createRpc(['https://a.example/rpc'], { warn: (m) => warns.push(m) });
    try {
      assert.equal(await rpc.call(SHORT, '0x12345678'), null);
      assert.equal(await rpc.call('0x1234', '0x12345678'), null);
      assert.equal(await rpc.call('not-an-address', '0x12345678'), null);
      assert.equal(mock.calls.length, 0);
      assert.equal(warns.length, 0);
    } finally {
      mock.restore();
    }
  });

  test('HTTP 429 仍 warn 並換節點，不冷卻主池', async () => {
    let n = 0;
    const mock = mockFetch(() => {
      n++;
      if (n === 1) return { ok: false, status: 429 };
      return jsonResult('0x1');
    });
    const warns = [];
    const rpc = createRpc(['https://a.example/rpc', 'https://b.example/rpc'], { warn: (m) => warns.push(m) });
    try {
      assert.equal(await rpc.rpc('eth_chainId', []), '0x1');
      assert.equal(n, 2);
      assert.ok(rpc.nodes.every((x) => x.coolUntil === 0));
      assert.ok(warns.some((w) => /429/.test(w)));
      assert.ok(!warns.some((w) => /冷卻/.test(w)));
    } finally {
      mock.restore();
    }
  });
});

test('resolveImpl 忽略 38 hex 嵌入地址', async () => {
  const junk38 = '1234567890abcdef1234567890abcdef123456';
  const rpc = fakeResolveRpc();
  await resolveImpl(rpc, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x63' + junk38);
  assert.ok(!rpc.calls.some((c) => c.method === 'call'));
  assert.ok(!rpc.calls.some((c) => c.to && c.to.length !== 42));
});

test('resolveImpl 只對 40 hex 嵌入地址 call', async () => {
  const impl = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const rpc = fakeResolveRpc();
  await resolveImpl(rpc, '0xcccccccccccccccccccccccccccccccccccccccc', '0x63' + impl);
  assert.ok(rpc.calls.some((c) => c.method === 'call' && c.to === '0x' + impl));
});

function withFakeNow(fn) {
  const orig = Date.now;
  let now = orig();
  Date.now = () => now;
  return Promise.resolve()
    .then(() => fn({
      advance(ms) { now += ms; },
    }))
    .finally(() => { Date.now = orig; });
}

describe('RPC 失敗 warn 去重', { concurrency: 1 }, () => {
  test('並行／連續 eth_getBlockByNumber 同一 host 只 warn 一次，該顆仍可被選', async () => {
    const mock = mockFetch((url) => {
      if (String(url).includes('1rpc.io')) return jsonError('limit exceeded');
      return jsonResult({ number: '0x1' });
    });
    const warns = [];
    const rpc = createRpc(
      ['https://1rpc.io/bnb', 'https://backup.example/rpc'],
      { warn: (m) => warns.push(m) },
    );
    try {
      const blocks = await Promise.all([1, 2, 3, 4].map((n) => rpc.getBlock(n)));
      assert.ok(blocks.every(Boolean));
      const oneRpcWarns = warns.filter((w) => /1rpc\.io/.test(w) && /eth_getBlockByNumber/.test(w));
      assert.equal(oneRpcWarns.length, 1);
      assert.ok(!warns.some((w) => /backup\.example/.test(w)));
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0));

      const afterParallel = mock.calls.length;
      const warnCount = warns.length;
      await rpc.getBlock(5);
      assert.equal(warns.length, warnCount);
      const extra = mock.calls.slice(afterParallel);
      assert.ok(extra.length > 0);
    } finally {
      mock.restore();
    }
  });

  test('warn 去重窗過後同一 host 同一方法可再 warn 一行', async () => {
    await withFakeNow(async (clock) => {
      const mock = mockFetch(() => jsonError('limit exceeded'));
      const warns = [];
      const rpc = createRpc(['https://1rpc.io/bnb'], { warn: (m) => warns.push(m) });
      try {
        await assert.rejects(() => rpc.getBlock(1));
        assert.equal(warns.length, 1);
        await assert.rejects(() => rpc.getBlock(2));
        assert.equal(warns.length, 1);
        clock.advance(61_000);
        await assert.rejects(() => rpc.getBlock(3));
        assert.equal(warns.length, 2);
        assert.ok(warns.every((w) => /1rpc\.io/.test(w) && /eth_getBlockByNumber/.test(w)));
      } finally {
        mock.restore();
      }
    });
  });

  test('不同 host 或不同方法仍可各印一行', async () => {
    const mock = mockFetch(() => jsonError('limit exceeded'));
    try {
      const hostWarns = [];
      const hosts = createRpc(
        ['https://1rpc.io/bnb', 'https://backup.example/rpc'],
        { warn: (m) => hostWarns.push(m) },
      );
      await assert.rejects(() => hosts.getBlock(1));
      assert.ok(hostWarns.some((w) => /eth_getBlockByNumber/.test(w) && /1rpc\.io/.test(w)));
      assert.ok(hostWarns.some((w) => /eth_getBlockByNumber/.test(w) && /backup\.example/.test(w)));
      assert.equal(hostWarns.length, 2);

      const methodWarns = [];
      const single = createRpc(['https://1rpc.io/bnb'], { warn: (m) => methodWarns.push(m) });
      await Promise.all([
        single.getBlock(2).catch(() => {}),
        single.getLogs({ address: ADDR }).catch(() => {}),
      ]);
      assert.equal(methodWarns.filter((w) => /eth_getBlockByNumber/.test(w)).length, 1);
      assert.equal(methodWarns.filter((w) => /eth_getLogs/.test(w)).length, 1);
    } finally {
      mock.restore();
    }
  });

  test('主池失敗只換下一顆，同一顆下一輪仍可被選', async () => {
    let hitsA = 0;
    const mock = mockFetch((url) => {
      if (String(url).includes('1rpc.io')) {
        hitsA++;
        return jsonError('limit exceeded');
      }
      return jsonResult('0x1');
    });
    const warns = [];
    const rpc = createRpc(
      ['https://1rpc.io/bnb', 'https://backup.example/rpc'],
      { warn: (m) => warns.push(m) },
    );
    try {
      assert.equal(await rpc.rpc('eth_chainId', []), '0x1');
      assert.equal(hitsA, 1);
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0));
      const before = mock.calls.length;
      for (let i = 0; i < rpc.nodes.length && hitsA < 2; i++) {
        assert.equal(await rpc.rpc('eth_chainId', []), '0x1');
      }
      const extra = mock.calls.slice(before);
      assert.ok(extra.some((c) => c.url.includes('1rpc.io')));
      assert.equal(hitsA, 2);
      assert.equal(warns.filter((w) => /1rpc\.io/.test(w) && /eth_chainId/.test(w)).length, 1);
    } finally {
      mock.restore();
    }
  });

  test('主池全 429 後下一輪仍有人可問', async () => {
    const mock = mockFetch(() => ({ ok: false, status: 429 }));
    const rpc = createRpc(['https://a.example/rpc', 'https://b.example/rpc']);
    try {
      await assert.rejects(() => rpc.rpc('eth_chainId', []));
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0));
      const before = mock.calls.length;
      await assert.rejects(() => rpc.rpc('eth_chainId', []));
      assert.ok(mock.calls.length > before);
    } finally {
      mock.restore();
    }
  });
});

describe('RPC 查高度與鑄造事件 logs', { concurrency: 1 }, () => {
  test('預設清單含 llamarpc 與 blockpi', () => {
    assert.ok(DEFAULT_RPCS.includes('https://binance.llamarpc.com'));
    assert.ok(DEFAULT_RPCS.includes('https://bsc.blockpi.network/v1/rpc/public'));
    assert.ok(DEFAULT_LOGS_RPCS.includes('https://bsc.blockpi.network/v1/rpc/public'));
    assert.ok(DEFAULT_LOGS_RPCS.includes('https://bsc.drpc.org'));
    assert.ok(!DEFAULT_LOGS_RPCS.includes('https://bsc-rpc.publicnode.com'));
    assert.ok(!DEFAULT_LOGS_RPCS.includes('https://bsc.publicnode.com'));
    assert.equal(DEFAULT_LOGS_RPCS[0], 'https://bsc.blockpi.network/v1/rpc/public');
    assert.equal(DEFAULT_LOGS_RPCS[1], 'https://bsc.drpc.org');
    assert.ok(DEFAULT_RECEIPT_RPCS.includes('https://bsc-dataseed.bnbchain.org'));
    assert.ok(DEFAULT_RECEIPT_RPCS.includes('https://bsc-dataseed1.defibit.io'));
    assert.ok(DEFAULT_RECEIPT_RPCS.includes('https://bsc-dataseed1.ninicoin.io'));
    assert.ok(DEFAULT_RECEIPT_RPCS.includes('https://bsc-rpc.publicnode.com'));
    assert.ok(!DEFAULT_RECEIPT_RPCS.some((u) => /blockpi|drpc/.test(u)));
  });

  test('eth_blockNumber 第一顆成功就不再問', async () => {
    const mock = mockFetch(() => jsonResult('0x10'));
    const rpc = createRpc([
      'https://a.example/rpc',
      'https://b.example/rpc',
      'https://c.example/rpc',
      'https://d.example/rpc',
    ]);
    try {
      assert.equal(await rpc.blockNumber(), 16);
      assert.equal(mock.calls.length, 1);
    } finally {
      mock.restore();
    }
  });

  test('eth_blockNumber 失敗再換下一顆，不 4 顆並行', async () => {
    let n = 0;
    const mock = mockFetch((url) => {
      n++;
      if (String(url).includes('a.example')) return jsonError('limit exceeded');
      return jsonResult('0x64');
    });
    const warns = [];
    const rpc = createRpc(
      ['https://a.example/rpc', 'https://b.example/rpc', 'https://c.example/rpc', 'https://d.example/rpc'],
      { warn: (m) => warns.push(m) },
    );
    try {
      assert.equal(await rpc.blockNumber(), 100);
      assert.equal(n, 2);
      assert.ok(rpc.nodes.every((x) => x.coolUntil === 0));
    } finally {
      mock.restore();
    }
  });

  test('無地址 getMintLogs 只打專用 logs 節點，不打主池', async () => {
    const mock = mockFetch((url) => {
      if (/blockpi|drpc/.test(String(url))) {
        return jsonResult([{ address: ADDR, topics: ['0xddf', '0x0'] }]);
      }
      return jsonResult('0x1');
    });
    const rpc = createRpc(['https://bsc-dataseed.bnbchain.org', 'https://1rpc.io/bnb']);
    try {
      const logs = await rpc.getMintLogs({ fromBlock: '0x1', toBlock: '0x2', topics: ['0xddf'] });
      assert.equal(logs.length, 1);
      assert.ok(mock.calls.length >= 1);
      assert.ok(mock.calls.every((c) => /blockpi|drpc/.test(c.url)));
      assert.ok(!mock.calls.some((c) => /dataseed|1rpc/.test(c.url)));
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0 && n.fails === 0));
    } finally {
      mock.restore();
    }
  });

  test('logs 節點失敗不冷卻主掃描池，改打獨立收據節點', async () => {
    const zero = padTopicAddress(ZERO);
    const mock = mockFetch((url, init) => {
      let method = '';
      try { method = JSON.parse(init?.body || '{}').method; } catch { /* ignore */ }
      if (method === 'eth_getLogs') return jsonError('limit exceeded');
      if (method === 'eth_getBlockReceipts') {
        if (/blockpi|drpc/.test(String(url))) return { ok: false, status: 503 };
        return jsonResult([{
          logs: [{
            address: ADDR,
            topics: [TOPIC_TRANSFER, zero, padTopicAddress(ADDR)],
          }],
        }]);
      }
      return jsonResult('0x64');
    });
    const warns = [];
    const rpc = createRpc(['https://1rpc.io/bnb'], { warn: (m) => warns.push(m) });
    try {
      const logs = await rpc.getMintLogs({
        fromBlock: '0x1',
        toBlock: '0x1',
        topics: [TOPIC_TRANSFER, zero],
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].address, ADDR);
      const receiptCalls = mock.calls.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_getBlockReceipts'; } catch { return false; }
      });
      assert.ok(receiptCalls.length >= 1);
      assert.ok(receiptCalls.every((c) => /dataseed|defibit|ninicoin|publicnode/.test(c.url)));
      assert.ok(!receiptCalls.some((c) => /blockpi|drpc|1rpc/.test(c.url)));
      const logCalls = mock.calls.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_getLogs'; } catch { return false; }
      });
      assert.ok(logCalls.length >= 1);
      assert.ok(logCalls.every((c) => /blockpi|drpc/.test(c.url)));
      assert.ok(!logCalls.some((c) => /publicnode/.test(c.url)));
      assert.equal(rpc.nodes[0].coolUntil, 0);
      assert.ok(rpc.logsNodes.every((n) => n.coolUntil > Date.now()));
      assert.ok(warns.some((w) => /改用區塊收據/.test(w)));
      assert.equal(await rpc.blockNumber(), 100);
      const heightCalls = mock.calls.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_blockNumber'; } catch { return false; }
      });
      assert.ok(heightCalls.every((c) => c.url.includes('1rpc.io')));
    } finally {
      mock.restore();
    }
  });

  test('logs 專線失敗會冷卻，下一輪跳過該顆', async () => {
    const mock = mockFetch((url) => {
      if (String(url).includes('blockpi')) return jsonError('limit exceeded');
      if (String(url).includes('drpc')) return jsonResult([{ address: ADDR }]);
      return jsonResult('0x1');
    });
    const warns = [];
    const rpc = createRpc(['https://main.example/rpc'], { warn: (m) => warns.push(m) });
    try {
      const logs = await rpc.getMintLogs({ fromBlock: '0x1', toBlock: '0x2', topics: ['0xddf'] });
      assert.equal(logs.length, 1);
      assert.ok(rpc.logsNodes[0].coolUntil > Date.now());
      assert.equal(rpc.logsNodes[1].coolUntil, 0);
      assert.equal(rpc.nodes[0].coolUntil, 0);
      assert.ok(warns.some((w) => /blockpi/.test(w) && /eth_getLogs/.test(w) && /冷卻/.test(w)));

      const before = mock.calls.length;
      const again = await rpc.getMintLogs({ fromBlock: '0x3', toBlock: '0x4', topics: ['0xddf'] });
      assert.equal(again.length, 1);
      const extra = mock.calls.slice(before);
      assert.ok(extra.length >= 1);
      assert.ok(extra.every((c) => c.url.includes('drpc')));
      assert.ok(!extra.some((c) => c.url.includes('blockpi')));
    } finally {
      mock.restore();
    }
  });

  test('兩顆 logs 主線同時掛才改打收據，不把 publicnode 當 getLogs 後備', async () => {
    const zero = padTopicAddress(ZERO);
    const mock = mockFetch((url, init) => {
      let method = '';
      try { method = JSON.parse(init?.body || '{}').method; } catch { /* ignore */ }
      if (method === 'eth_getLogs') {
        if (/publicnode/.test(String(url))) return jsonError('Please specify an address');
        return { ok: false, status: 503 };
      }
      if (method === 'eth_getBlockReceipts') {
        if (/blockpi|drpc/.test(String(url))) return { ok: false, status: 503 };
        return jsonResult([{
          logs: [{ address: ADDR, topics: [TOPIC_TRANSFER, zero, padTopicAddress(ADDR)] }],
        }]);
      }
      return jsonResult('0x1');
    });
    const warns = [];
    const rpc = createRpc(
      ['https://bsc-dataseed.bnbchain.org', 'https://1rpc.io/bnb'],
      { warn: (m) => warns.push(m) },
    );
    try {
      const logs = await rpc.getMintLogs({
        fromBlock: '0x1',
        toBlock: '0x2',
        topics: [TOPIC_TRANSFER, zero],
      });
      assert.equal(logs.length, 2);
      assert.ok(mock.calls.some((c) => c.url.includes('blockpi')));
      assert.ok(mock.calls.some((c) => c.url.includes('drpc')));
      const logCalls = mock.calls.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_getLogs'; } catch { return false; }
      });
      assert.ok(!logCalls.some((c) => /publicnode/.test(c.url)));
      const receiptCalls = mock.calls.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_getBlockReceipts'; } catch { return false; }
      });
      assert.ok(receiptCalls.length >= 1);
      assert.ok(receiptCalls.every((c) => /dataseed|defibit|ninicoin|publicnode/.test(c.url)));
      assert.ok(!mock.calls.some((c) => c.url.includes('1rpc')));
      assert.ok(rpc.logsNodes[0].coolUntil > Date.now());
      assert.ok(rpc.logsNodes[1].coolUntil > Date.now());
      assert.ok(rpc.nodes.every((n) => n.coolUntil === 0 && n.fails === 0));
      assert.ok(warns.some((w) => /改用區塊收據/.test(w)));

      const before = mock.calls.length;
      const again = await rpc.getMintLogs({
        fromBlock: '0x3',
        toBlock: '0x4',
        topics: [TOPIC_TRANSFER, zero],
      });
      assert.equal(again.length, 2);
      const extra = mock.calls.slice(before);
      const extraLogs = extra.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_getLogs'; } catch { return false; }
      });
      const extraReceipts = extra.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_getBlockReceipts'; } catch { return false; }
      });
      assert.ok(extraReceipts.length >= 1);
      assert.ok(!extraLogs.some((c) => /publicnode/.test(c.url)));
      assert.ok(!extra.some((c) => /blockpi|drpc/.test(c.url) && JSON.parse(c.body).method === 'eth_getBlockReceipts'));
    } finally {
      mock.restore();
    }
  });

  test('收據也失敗則冷卻該顆，不改打主池或 logs 主線', async () => {
    const mock = mockFetch((url, init) => {
      let method = '';
      try { method = JSON.parse(init?.body || '{}').method; } catch { /* ignore */ }
      if (method === 'eth_getLogs' || method === 'eth_getBlockReceipts') {
        return { ok: false, status: 429 };
      }
      return jsonResult('0x1');
    });
    const rpc = createRpc(['https://1rpc.io/bnb']);
    try {
      await assert.rejects(
        () => rpc.getMintLogs({ fromBlock: '0x1', toBlock: '0x1', topics: ['0xddf'] }),
        /全部失敗|全部節點失敗|HTTP 429/,
      );
      assert.ok(mock.calls.every((c) => /blockpi|drpc|publicnode|dataseed|defibit|ninicoin/.test(c.url)));
      assert.ok(!mock.calls.some((c) => c.url.includes('1rpc')));
      const receiptCalls = mock.calls.filter((c) => {
        try { return JSON.parse(c.body).method === 'eth_getBlockReceipts'; } catch { return false; }
      });
      assert.ok(receiptCalls.length >= 1);
      assert.ok(!receiptCalls.some((c) => /blockpi|drpc/.test(c.url)));
      assert.ok(rpc.logsNodes.every((n) => n.coolUntil > Date.now()));
      assert.ok(rpc.receiptsNodes.every((n) => n.coolUntil > Date.now()));
      assert.equal(rpc.nodes[0].coolUntil, 0);
    } finally {
      mock.restore();
    }
  });

  test('收據失敗只冷卻該顆，下一塊跳過它', async () => {
    const zero = padTopicAddress(ZERO);
    let dataseedHits = 0;
    const mock = mockFetch((url, init) => {
      let method = '';
      try { method = JSON.parse(init?.body || '{}').method; } catch { /* ignore */ }
      if (method === 'eth_getLogs') return { ok: false, status: 503 };
      if (method === 'eth_getBlockReceipts') {
        if (/bnbchain\.org/.test(String(url))) {
          dataseedHits++;
          return { ok: false, status: 429 };
        }
        return jsonResult([{
          logs: [{ address: ADDR, topics: [TOPIC_TRANSFER, zero, padTopicAddress(ADDR)] }],
        }]);
      }
      return jsonResult('0x1');
    });
    const rpc = createRpc(['https://1rpc.io/bnb']);
    try {
      const logs = await rpc.getMintLogs({
        fromBlock: '0x1',
        toBlock: '0x2',
        topics: [TOPIC_TRANSFER, zero],
      });
      assert.equal(logs.length, 2);
      const cooled = rpc.receiptsNodes.filter((n) => n.coolUntil > Date.now());
      assert.ok(cooled.some((n) => /bnbchain\.org/.test(n.url)));
      const before = dataseedHits;
      const again = await rpc.getMintLogs({
        fromBlock: '0x3',
        toBlock: '0x3',
        topics: [TOPIC_TRANSFER, zero],
      });
      assert.equal(again.length, 1);
      assert.equal(dataseedHits, before);
      assert.equal(rpc.nodes[0].coolUntil, 0);
    } finally {
      mock.restore();
    }
  });
});
