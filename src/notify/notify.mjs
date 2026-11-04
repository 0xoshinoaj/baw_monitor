import { createDiscord } from './discord.mjs';
import { createTelegram } from './telegram.mjs';

export function createNotifier(cfg, log, hooks = {}) {
  const telegram = createTelegram(cfg, log);
  const discord = createDiscord(cfg, log, hooks);
  const enabled = telegram.enabled || discord.enabled;

  async function emit(ev) {
    const line = `${enabled ? 'notify' : 'notify(off)'} ${ev.type} ${ev.title || ''}`;
    if (!enabled) {
      log?.info(line);
      return;
    }
    log?.info(line, { console: false });
    const jobs = [];
    if (discord.enabled) jobs.push(discord.emit(ev));
    if (telegram.enabled) jobs.push(telegram.emit(ev));
    await Promise.all(jobs);
  }

  return { enabled, emit, telegram, discord };
}
