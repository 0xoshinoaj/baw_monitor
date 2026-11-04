/** 在 TOML 文字上改單一鍵值，保留註解與其餘區塊。 */

import { readFileSync, writeFileSync } from 'node:fs';

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tomlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatTomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(', ')}]`;
  return tomlQuote(value);
}

export function findTableRange(text, header, index = 0) {
  if (!header) {
    const next = text.search(/\n[ \t]*\[/);
    return { start: 0, end: next === -1 ? text.length : next };
  }
  const hdrRe = new RegExp(`^[ \\t]*${escapeRe(header)}[ \\t]*(?:#.*)?$`, 'gm');
  let found = 0;
  let m;
  while ((m = hdrRe.exec(text))) {
    if (found === index) {
      const start = m.index;
      const after = start + m[0].length;
      const nm = /\n[ \t]*\[/.exec(text.slice(after));
      const end = nm ? after + nm.index : text.length;
      return { start, end };
    }
    found++;
  }
  return null;
}

export function patchTomlKey(text, header, key, value, tableIndex = 0) {
  const rendered = formatTomlValue(value);
  const range = findTableRange(text, header, tableIndex);
  if (!range) {
    return `${text.replace(/\s*$/, '')}\n\n${header}\n${key} = ${rendered}\n`;
  }
  const block = text.slice(range.start, range.end);
  const re = new RegExp(
    `^([ \\t]*${escapeRe(key)}[ \\t]*=[ \\t]*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^#\\n]+?)([ \\t]*(?:#.*)?)[ \\t]*$`,
    'm',
  );
  if (re.test(block)) {
    return text.slice(0, range.start) + block.replace(re, `$1${rendered}$2`) + text.slice(range.end);
  }
  const nl = block.indexOf('\n');
  const inserted = nl === -1
    ? `${block}\n${key} = ${rendered}\n`
    : `${block.slice(0, nl + 1)}${key} = ${rendered}\n${block.slice(nl + 1)}`;
  return text.slice(0, range.start) + inserted + text.slice(range.end);
}

export function applyTomlPatches(text, patches) {
  let out = text;
  for (const p of patches) {
    out = patchTomlKey(out, p.header, p.key, p.value, p.index ?? 0);
  }
  return out;
}

export function writeTomlPatches(tomlPath, patches) {
  const out = applyTomlPatches(readFileSync(tomlPath, 'utf8'), patches);
  writeFileSync(tomlPath, out);
  return out;
}

export function appendWalletTable(text, wallet) {
  const lines = ['', '[[wallets]]', `name = ${tomlQuote(wallet.name)}`, `address = ${tomlQuote(wallet.address)}`];
  if (wallet.bawDir) lines.push(`bawDir = ${tomlQuote(wallet.bawDir)}`);
  if (wallet.bawPkg) lines.push(`bawPkg = ${tomlQuote(wallet.bawPkg)}`);
  if (wallet.instanceId && wallet.instanceId !== wallet.name) {
    lines.push(`instanceId = ${tomlQuote(wallet.instanceId)}`);
  }
  return text.replace(/\s*$/, '') + lines.join('\n') + '\n';
}
