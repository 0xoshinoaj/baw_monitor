import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_CODES } from '../src/lib/const.mjs';
import { inspectSimulation } from '../src/exec/preview.mjs';
import { parseCommand } from '../src/notify/commands.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

test('正常：付出 BNB、拿到代幣', () => {
  const r = inspectSimulation({
    sim: {
      balanceChanges: [
        { owner: wallet, contractAddress: native, change: -1e16, tokenType: 'Native' },
        { owner: wallet, contractAddress: token, change: 1e20, tokenType: 'Erc20' },
      ],
    },
    wallet,
    expectedValueWei: 10n ** 16n,
  });
  assert.equal(r.ok, true);
});

test('多餘授權硬擋', () => {
  const r = inspectSimulation({
    sim: {
      allowanceChanges: [{ spender: '0x3333333333333333333333333333333333333333' }],
      balanceChanges: [{ owner: wallet, contractAddress: token, change: 1, tokenType: 'Erc20' }],
    },
    wallet,
    expectedValueWei: 0n,
  });
  assert.equal(r.ok, false);
  assert.ok(r.codes.includes(BLOCK_CODES.EXTRA_APPROVAL));
});

test('允許的授權不擋', () => {
  const spender = '0x3333333333333333333333333333333333333333';
  const r = inspectSimulation({
    sim: {
      allowanceChanges: [{ spender }],
      balanceChanges: [{ owner: wallet, contractAddress: token, change: 1, tokenType: 'Erc20' }],
    },
    wallet,
    allowApproveTo: [spender],
  });
  assert.equal(r.ok, true);
});

test('扣到預期外資產', () => {
  const r = inspectSimulation({
    sim: {
      balanceChanges: [
        { owner: wallet, contractAddress: '0x4444444444444444444444444444444444444444', change: -100, tokenType: 'Erc20' },
        { owner: wallet, contractAddress: token, change: 1, tokenType: 'Erc20' },
      ],
    },
    wallet,
  });
  assert.ok(r.codes.includes(BLOCK_CODES.UNEXPECTED_DEBIT));
});

test('淨拿到 0', () => {
  const r = inspectSimulation({
    sim: { balanceChanges: [{ owner: wallet, contractAddress: native, change: -1, tokenType: 'Native' }] },
    wallet,
    expectedValueWei: 1n,
  });
  assert.ok(r.codes.includes(BLOCK_CODES.ZERO_NET));
});

test('replay 他人地址替換失敗', () => {
  const r = inspectSimulation({
    sim: { balanceChanges: [{ owner: wallet, contractAddress: token, change: 1, tokenType: 'Erc20' }] },
    wallet,
    replayForeignUnresolved: true,
  });
  assert.ok(r.codes.includes(BLOCK_CODES.REPLAY_FOREIGN_ADDR));
});

test('BNB 扣超過預期', () => {
  const r = inspectSimulation({
    sim: {
      balanceChanges: [
        { owner: wallet, contractAddress: native, change: -2e18, tokenType: 'Native' },
        { owner: wallet, contractAddress: token, change: 1, tokenType: 'Erc20' },
      ],
    },
    wallet,
    expectedValueWei: 10n ** 16n,
  });
  assert.ok(r.codes.includes(BLOCK_CODES.EXCESS_BNB));
});

test('指令解析不用 emoji', () => {
  assert.deepEqual(parseCommand('賣 ABC 一半'), { op: 'sell', target: 'ABC', half: true });
  assert.equal(parseCommand('打 0x1111111111111111111111111111111111111111').op, 'mint');
  assert.equal(parseCommand('餘額').op, 'balance');
  assert.equal(parseCommand('戰績').op, 'stats');
  assert.equal(parseCommand('指令').op, 'help');
});
