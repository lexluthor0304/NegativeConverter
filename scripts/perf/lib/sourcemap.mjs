// Map positions in the production bundle (built with --sourcemap) back to
// `src/` file:line with node:module's SourceMap, for CPU-profile hot
// functions, Long Animation Frame script attribution and hang stacks.

import { existsSync, readFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { join, normalize, sep } from 'node:path';

/** "../../src/app/main.js" or "webpack://x/./src/app/main.js" → "src/app/main.js". */
export function normalizeSourcePath(source) {
  if (!source) return source;
  let path = String(source).replace(/^[a-z]+:\/\/[^/]*\//i, '').replace(/\\/g, '/');
  const node = path.lastIndexOf('node_modules/');
  if (node >= 0) return path.slice(node);
  const src = path.lastIndexOf('src/');
  if (src >= 0) return path.slice(src);
  while (path.startsWith('../') || path.startsWith('./')) path = path.slice(path.indexOf('/') + 1);
  return path;
}

/** Character offset → 0-based { line, column } in `text`. */
export function charPositionToLineColumn(text, position) {
  if (!Number.isFinite(position) || position < 0) return null;
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < position; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: position - lineStart };
}

export function createSourceMapper({ distDir, origin = null }) {
  const maps = new Map();
  const texts = new Map();

  function fileFor(url) {
    if (!url || !distDir) return null;
    let pathname;
    try {
      const parsed = new URL(url);
      if (origin && parsed.origin !== new URL(origin).origin) return null;
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    const file = normalize(join(distDir, pathname));
    return file.startsWith(normalize(distDir) + sep) || file === normalize(distDir) ? file : null;
  }

  function mapFor(url) {
    const file = fileFor(url);
    if (!file) return null;
    if (maps.has(file)) return maps.get(file);
    let map = null;
    try {
      if (existsSync(`${file}.map`)) map = new SourceMap(JSON.parse(readFileSync(`${file}.map`, 'utf8')));
    } catch {
      map = null;
    }
    maps.set(file, map);
    return map;
  }

  function textFor(url) {
    const file = fileFor(url);
    if (!file) return null;
    if (!texts.has(file)) {
      try { texts.set(file, readFileSync(file, 'utf8')); } catch { texts.set(file, null); }
    }
    return texts.get(file);
  }

  /** 0-based line and column in the bundle → { source, line (1-based), column, name } */
  function map(url, line, column) {
    const sourceMap = mapFor(url);
    if (!sourceMap || !Number.isFinite(line) || line < 0) return null;
    const entry = sourceMap.findEntry(line, Math.max(0, column || 0));
    if (!entry || !entry.originalSource) return null;
    return {
      source: normalizeSourcePath(entry.originalSource),
      line: entry.originalLine + 1,
      column: entry.originalColumn,
      name: entry.name || null
    };
  }

  function mapCharPosition(url, position) {
    const text = textFor(url);
    if (!text) return null;
    const location = charPositionToLineColumn(text, position);
    return location ? map(url, location.line, location.column) : null;
  }

  /** "src/app/main.js:4955" or the bundle URL tail when unmapped. */
  function label(url, line, column) {
    const mapped = map(url, line, column);
    if (mapped) return `${mapped.source}:${mapped.line}`;
    if (!url) return '(native)';
    const tail = String(url).split('/').pop();
    return Number.isFinite(line) ? `${tail}:${line + 1}` : tail;
  }

  return { map, mapCharPosition, label, fileFor };
}
