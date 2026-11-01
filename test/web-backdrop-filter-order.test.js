import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const ROOT = new URL('../web/src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(vue|css)$/.test(name) && !/\.spec\./.test(name) ? [path] : [];
  });
}

// The production CSS minifier keeps only the last of a prefixed/standard pair
// with the same value. With the standard one first, the build shipped only
// -webkit-backdrop-filter, which Chromium and WebView2 ignore: no glass at all
// in the installed console (Jevons 11-01). The standard property must come last.
test('every glass names backdrop-filter after its -webkit- copy, so the build keeps it', () => {
  const wrong = [];
  for (const path of files(ROOT)) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of css.match(/\{[^{}]*\}/g) ?? []) {
      const standard = block.search(/(^|[^-])backdrop-filter\s*:/);
      const prefixed = block.indexOf('-webkit-backdrop-filter');
      if (prefixed >= 0 && (standard < 0 || standard < prefixed)) wrong.push(relative(ROOT, path));
    }
  }
  assert.deepEqual(wrong, []);
});
