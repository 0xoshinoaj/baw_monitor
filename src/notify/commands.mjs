import { EVENT_TYPES } from '../lib/const.mjs';
import { event } from './events.mjs';
import { lc } from '../lib/util.mjs';

export function parseCommand(text) {
  const txt = String(text || '').trim();
  let m;
  if ((m = txt.match(/^(?:賣|卖|sell)\s+(\S+?)(?:\s+(一半|半|half))?$/i))) {
    return { op: 'sell', target: m[1], half: !!m[2] };
  }
  if ((m = txt.match(/^(\S+?)\s*(?:全出|全賣|全卖)$/i))) return { op: 'sell', target: m[1], half: false };
  if ((m = txt.match(/^(\S+?)\s*(?:出一半|賣一半|卖一半)$/i))) return { op: 'sell', target: m[1], half: true };
  if ((m = txt.match(/^(?:打|確認|确认|mint|confirm)\s+(0x[a-fA-F0-9]{40})$/i))) {
    return { op: 'mint', address: lc(m[1]) };
  }
  if (/^(餘額|余额|錢包|钱包|balance)$/i.test(txt)) return { op: 'balance' };
  if (/^(持倉|持仓|holdings?)$/i.test(txt)) return { op: 'holdings' };
  if (/^(戰績|战绩|統計|统计|stats?)$/i.test(txt)) return { op: 'stats' };
  if (/^(help|指令|說明|说明)$/i.test(txt)) return { op: 'help' };
  return { op: 'unknown', raw: txt };
}

export function helpEvent() {
  return event(EVENT_TYPES.CMD_REPLY, {
    title: '可用指令',
    lines: [
      '賣 XXX → 所有錢包全賣',
      '賣 XXX 一半 → 各賣一半',
      '打 0x合約 → 確認模式下執行該項目',
      '餘額 → 各錢包 BNB',
      '持倉 → 還沒賣的幣',
      '戰績 → 來自 positions / risk，不是 log',
    ],
    channel: 'dm',
  });
}
