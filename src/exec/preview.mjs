import { BLOCK_CODES, NATIVE_BNB, USDT, WBNB } from '../lib/const.mjs';
import { lc, sameAddr } from '../lib/util.mjs';

const PAY_DEFAULTS = [NATIVE_BNB, USDT, WBNB];

function mine(sim, wallet) {
  return (sim?.balanceChanges || []).filter((b) => sameAddr(b.owner, wallet));
}

function isNativeToken(addr) {
  return lc(addr).startsWith('0xeeee');
}

/**
 * 檢查 baw preview 的 simulationResult。
 * 硬擋：多餘授權、扣到預期外資產、淨拿到 0、replay 含他人地址且替換失敗。
 */
export function inspectSimulation({
  sim,
  wallet,
  expectedValueWei = 0n,
  payTokens = PAY_DEFAULTS,
  allowApproveTo = [],
  replayForeignUnresolved = false,
}) {
  const blocks = [];
  const warnings = [];
  const mineRows = mine(sim, wallet);
  const pay = new Set(payTokens.map(lc));
  const allow = new Set(allowApproveTo.map(lc));

  if (replayForeignUnresolved) {
    blocks.push({ code: BLOCK_CODES.REPLAY_FOREIGN_ADDR, message: 'replay 含他人地址且替換失敗' });
  }

  for (const a of sim?.allowanceChanges || []) {
    const spender = lc(a.spender);
    if (allow.size && allow.has(spender)) continue;
    if (allow.size === 0) {
      blocks.push({ code: BLOCK_CODES.EXTRA_APPROVAL, message: `多餘授權給 ${a.spender}` });
    } else {
      blocks.push({ code: BLOCK_CODES.EXTRA_APPROVAL, message: `授權對象不在允許名單：${a.spender}` });
    }
  }
  if ((sim?.authorityChanges || []).length) {
    blocks.push({ code: BLOCK_CODES.AUTHORITY_CHANGE, message: '模擬出現權限變更' });
  }

  const expectedWei = BigInt(expectedValueWei || 0);
  for (const b of mineRows) {
    const change = Number(b.change);
    if (!(change < 0)) continue;
    const token = lc(b.contractAddress);
    if (isNativeToken(token)) {
      if (-change > Number(expectedWei) * 1.0000001 + 1) {
        blocks.push({ code: BLOCK_CODES.EXCESS_BNB, message: '會扣的 BNB 比說好的多' });
      }
      continue;
    }
    if (!pay.has(token)) {
      blocks.push({ code: BLOCK_CODES.UNEXPECTED_DEBIT, message: `會扣到預期外資產 ${b.contractAddress}` });
    }
  }

  const got = mineRows.some((b) => {
    const change = Number(b.change);
    if (change > 0) return true;
    if (/Erc721|Erc1155/i.test(b.tokenType || '') && !(change < 0)) return true;
    return false;
  });
  if (!got) {
    blocks.push({ code: BLOCK_CODES.ZERO_NET, message: '淨拿到 0（可能鑄給別人或模擬無入帳）' });
  }

  const received = mineRows.filter((b) => Number(b.change) > 0);
  const spent = mineRows.filter((b) => Number(b.change) < 0);
  return {
    ok: blocks.length === 0,
    blocks,
    warnings,
    received,
    spent,
    codes: blocks.map((b) => b.code),
  };
}

export function receivedErc20(sim, wallet) {
  return (sim?.balanceChanges || []).filter((b) =>
    sameAddr(b.owner, wallet) && Number(b.change) > 0 && String(b.tokenType || '') === 'Erc20'
    && !lc(b.contractAddress).startsWith('0xeeee') && lc(b.contractAddress) !== USDT && lc(b.contractAddress) !== WBNB);
}

export function spentUsdEstimate(sim, wallet, bnbUsd) {
  let usd = 0;
  for (const b of mine(sim, wallet)) {
    if (!(Number(b.change) < 0)) continue;
    const token = lc(b.contractAddress);
    if (isNativeToken(token)) usd += (-Number(b.change) / 1e18) * (bnbUsd || 0);
    else if (token === USDT) usd += -Number(b.change) / 1e18;
  }
  return usd;
}

export function previewUnsafeReason(check) {
  if (check.ok) return '';
  return check.blocks.map((b) => `${b.code}: ${b.message}`).join('；');
}
