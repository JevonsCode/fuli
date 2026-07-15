import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';

const WEB_ROOT = resolve('web');

test('web app module graph reaches every focused behavior module', () => {
  const reachable = collectModules(resolve(WEB_ROOT, 'app.js'));
  for (const module of [
    'js/actions.js', 'js/api.js', 'js/elements.js', 'js/feedback.js', 'js/lens.js',
    'js/lens-view.js', 'js/render.js', 'js/render-candidates.js',
    'js/render-connections.js', 'js/render-memory.js', 'js/render-overview.js',
    'js/state.js', 'js/util.js', 'js/views.js'
  ]) assert.equal(reachable.has(module), true, module);
  assert.equal([...reachable].some((module) => module.endsWith('/entries.js')), false);
});

function collectModules(entry) {
  const found = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    const name = relative(WEB_ROOT, file).replaceAll('\\', '/');
    if (found.has(name)) continue;
    assert.equal(existsSync(file), true, `Missing import target: ${name}`);
    found.add(name);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s+)["'](\.[^"']+)["']/g)) {
      pending.push(resolve(dirname(file), match[1]));
    }
  }
  return found;
}
