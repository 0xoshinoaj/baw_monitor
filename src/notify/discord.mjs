import { EVENT_TYPES } from '../lib/const.mjs';
import { formatBscscanLink, formatEvent, isPassNotifyType, linesMentionAddress } from './events.mjs';

export const DISCORD_LIMIT = 2000;

const ALERT_TYPES = new Set([
  EVENT_TYPES.MINT_BLOCKED,
  EVENT_TYPES.MINT_FAILED,
  EVENT_TYPES.MINT_PENDING_CONFIRM,
  EVENT_TYPES.SESSION_LOGIN,
  EVENT_TYPES.SESSION_DEVMODE,
  EVENT_TYPES.SESSION_LOW_BNB,
  EVENT_TYPES.RISK_DRAIN,
  EVENT_TYPES.RISK_SERIAL,
  EVENT_TYPES.SELL_FAILED,
]);

const EMBED_TYPES = new Set([
  ...ALERT_TYPES,
  EVENT_TYPES.MONITOR_STARTED,
  EVENT_TYPES.PROJECT_ELIGIBLE,
  EVENT_TYPES.MINT_EXECUTED,
  EVENT_TYPES.SELL_EXECUTED,
]);

const COLORS = {
  [EVENT_TYPES.MINT_BLOCKED]: 0xE74C3C,
  [EVENT_TYPES.MINT_FAILED]: 0xE74C3C,
  [EVENT_TYPES.RISK_DRAIN]: 0xE74C3C,
  [EVENT_TYPES.RISK_SERIAL]: 0xE74C3C,
  [EVENT_TYPES.SELL_FAILED]: 0xE74C3C,
  [EVENT_TYPES.MINT_PENDING_CONFIRM]: 0xF39C12,
  [EVENT_TYPES.SESSION_LOGIN]: 0xF1C40F,
  [EVENT_TYPES.SESSION_DEVMODE]: 0xF1C40F,
  [EVENT_TYPES.SESSION_LOW_BNB]: 0xF1C40F,
  [EVENT_TYPES.MINT_EXECUTED]: 0x2ECC71,
  [EVENT_TYPES.SELL_EXECUTED]: 0x2ECC71,
  [EVENT_TYPES.PROJECT_ELIGIBLE]: 0x3498DB,
  [EVENT_TYPES.MONITOR_STARTED]: 0x3498DB,
};

export function isAlertType(type) {
  return ALERT_TYPES.has(type);
}

export function isEmbedType(type) {
  return EMBED_TYPES.has(type);
}

export function colorFor(type) {
  return COLORS[type] ?? 0x95A5A6;
}

export function isDiscordWebhook(url) {
  return /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i.test(String(url || '').trim());
}

/** 盡量沿換行切，單段不超過 max（Discord webhook content 上限 2000）。 */
export function chunkText(text, max = DISCORD_LIMIT) {
  const src = String(text ?? '');
  if (!src) return [''];
  if (src.length <= max) return [src];
  const chunks = [];
  let rest = src;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks.filter((c) => c.length);
}

export function buildDiscordMessages(ev) {
  const title = String(ev.title || ev.type || '');
  const lines = (ev.lines || []).filter(Boolean).map(String);
  const body = lines.join('\n');

  if (isEmbedType(ev.type)) {
    const descChunks = chunkText(body, DISCORD_LIMIT);
    const parts = descChunks.length ? descChunks : [''];
    return parts.map((chunk, i) => {
      if (i === 0) {
        const embed = {
          title: title.slice(0, 256),
          color: colorFor(ev.type),
          footer: { text: ev.type },
          timestamp: new Date(ev.at || Date.now()).toISOString(),
        };
        if (chunk) embed.description = chunk;
        if (ev.address && !linesMentionAddress(lines, ev.address)) {
          embed.fields = [{ name: '合約', value: formatBscscanLink(ev.address), inline: false }];
        }
        return { embeds: [embed], allowed_mentions: { parse: [] } };
      }
      return { content: chunk, allowed_mentions: { parse: [] } };
    });
  }

  const text = `[${ev.type}]\n${formatEvent(ev)}`;
  return chunkText(text, DISCORD_LIMIT).map((content) => ({
    content,
    allowed_mentions: { parse: [] },
  }));
}

export async function sendDiscordTest(url, { fetchImpl = fetch } = {}) {
  if (!isDiscordWebhook(url)) throw new Error('必須是 Discord webhook URL（https://discord.com/api/webhooks/...）');
  await postWebhook(url, {
    username: 'baw-monitor',
    content: 'baw-monitor 測試通知：webhook 可用。',
    allowed_mentions: { parse: [] },
  }, fetchImpl);
}

async function postWebhook(url, payload, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Discord ${res.status} ${t.slice(0, 200)}`);
  }
}

export function webhookForEvent(ev, { webhook, passWebhook } = {}) {
  const pass = String(passWebhook || '').trim();
  if (isPassNotifyType(ev?.type) && isDiscordWebhook(pass)) return pass;
  return String(webhook || '').trim();
}

export function createDiscord(cfg, log, { fetchImpl = fetch } = {}) {
  const webhook = String(cfg.discord?.webhook || '').trim();
  const passWebhook = String(cfg.discord?.pass_webhook || cfg.discord?.passWebhook || '').trim();
  const alertWebhook = String(cfg.discord?.alert_webhook || cfg.discord?.alertWebhook || '').trim();
  const enabled = isDiscordWebhook(webhook);

  async function emit(ev) {
    if (!enabled) return;
    const messages = buildDiscordMessages(ev);
    const target = webhookForEvent(ev, { webhook, passWebhook });
    const urls = [target];
    if (isDiscordWebhook(alertWebhook) && alertWebhook !== target && isAlertType(ev.type)) {
      urls.push(alertWebhook);
    }
    try {
      for (const url of urls) {
        for (const msg of messages) {
          await postWebhook(url, { username: 'baw-monitor', ...msg }, fetchImpl);
        }
      }
    } catch (e) {
      log?.warn('Discord 發送失敗：' + e.message);
    }
  }

  return { enabled, emit, webhook, passWebhook, alertWebhook };
}
