/**
 * 終端機 ANSI 顏色。僅 TTY 上色；NO_COLOR 或非 TTY 回傳原字串。
 */

export function colorEnabled(stream = process.stdout, { env = process.env } = {}) {
  const v = env?.NO_COLOR;
  if (v != null && String(v) !== '') return false;
  return !!(stream && stream.isTTY);
}

function paint(code, text, stream, opts) {
  const s = String(text ?? '');
  if (!s || !colorEnabled(stream, opts)) return s;
  return `\u001b[${code}m${s}\u001b[0m`;
}

export function green(text, stream, opts) {
  return paint(32, text, stream, opts);
}

export function yellow(text, stream, opts) {
  return paint(33, text, stream, opts);
}

export function red(text, stream, opts) {
  return paint(31, text, stream, opts);
}
