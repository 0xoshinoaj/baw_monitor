import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadJson(file, fallback) {
  try {
    if (!existsSync(file)) return structuredClone(fallback);
    return { ...structuredClone(fallback), ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return structuredClone(fallback);
  }
}

export function saveJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function createJsonStore(file, fallback) {
  let data = loadJson(file, fallback);
  let dirty = false;
  return {
    get data() { return data; },
    set(next) { data = next; dirty = true; },
    mark() { dirty = true; },
    save(force = false) {
      if (!dirty && !force) return;
      saveJson(file, data);
      dirty = false;
    },
  };
}
