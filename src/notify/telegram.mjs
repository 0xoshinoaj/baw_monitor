import { EVENT_TYPES } from '../lib/const.mjs';
import { formatEvent, isSilent, routeEvent } from './events.mjs';

export function createTelegram(cfg, log) {
  const token = cfg.telegram.botToken;
  const dm = cfg.telegram.chatId;
  const group = cfg.telegram.groupChatId;
  const enabled = !!(token && dm);

  async function api(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return res.json();
  }

  async function sendChat(chatId, text, silent) {
    if (!chatId) return;
    await api('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      disable_notification: !!silent,
    });
  }

  async function emit(ev) {
    if (!enabled) return;
    const text = `[${ev.type}]\n${formatEvent(ev)}`;
    const dest = routeEvent(ev);
    const silent = isSilent(ev);
    try {
      if (dest === 'dm' || dest === 'both') await sendChat(dm, text, silent);
      if ((dest === 'group' || dest === 'both') && group) await sendChat(group, text, silent);
    } catch (e) {
      log?.warn('TG 發送失敗：' + e.message);
    }
  }

  async function poll(offset) {
    if (!enabled) return { offset, messages: [] };
    try {
      const r = await api('getUpdates', { timeout: 25, offset });
      const updates = r.result || [];
      const next = updates.length ? updates[updates.length - 1].update_id + 1 : offset;
      const messages = [];
      for (const u of updates) {
        const m = u.message;
        if (!m?.text) continue;
        if (String(m.chat?.id) !== String(dm)) continue;
        if (Date.now() / 1000 - m.date > 120) continue;
        messages.push({ text: m.text.trim().replace(/^\//, ''), chatId: m.chat.id });
      }
      return { offset: next, messages };
    } catch {
      return { offset, messages: [] };
    }
  }

  return { enabled, emit, poll, EVENT_TYPES };
}
