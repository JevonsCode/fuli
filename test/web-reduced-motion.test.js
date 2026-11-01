import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';
import { compileStyle, parse } from '@vue/compiler-sfc';

const MIRROR = ':root[data-motion="reduced"]';

function webStyleSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return webStyleSources(path);
    const extension = extname(entry.name);
    if (extension === '.css') return [{ path, css: readFileSync(path, 'utf8'), scoped: false }];
    if (extension !== '.vue') return [];
    return parse(readFileSync(path, 'utf8')).descriptor.styles
      .filter((style) => !style.src)
      .map((style) => ({ path, css: style.content, scoped: Boolean(style.scoped) }));
  });
}

// The console's own styles and the brand's generated motion stylesheet (web/assets/brand).
const consoleStyleSources = () => ['web/src', 'web/assets'].flatMap((directory) => webStyleSources(directory));

test('every system reduced-motion rule has an in-app reduce-motion mirror', () => {
  const missing = consoleStyleSources()
    .filter(({ css }) => css.includes('prefers-reduced-motion: reduce') && !css.includes(MIRROR))
    .map(({ path }) => path);
  assert.deepEqual(missing, []);
});

test('in-app reduce-motion selectors stay reachable after scoped compilation', () => {
  const unreachable = consoleStyleSources()
    .filter(({ css }) => css.includes(MIRROR))
    .flatMap(({ path, css, scoped }) => {
      const result = compileStyle({ source: css, filename: path, id: 'data-v-probe', scoped });
      assert.deepEqual(result.errors, [], path);
      // A scope attribute on :root itself can never match a component element.
      return result.code.includes(`${MIRROR}[data-v-probe]`) ? [path] : [];
    });
  assert.deepEqual(unreachable, []);
});
