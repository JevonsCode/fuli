import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPluginRuntime } from '../src/plugin-runtime.js';
import { createSelectionPlugin } from '../src/selection-plugin.js';

const manifest = JSON.parse(
  await readFile(new URL('../plugin.json', import.meta.url), 'utf8')
);

test('selection plugin copies and delegates translate/explain through host ports', async () => {
  const clipboard = [];
  const requests = [];
  const runtime = createPluginRuntime({
    ports: {
      clipboard: { writeText: async (text) => clipboard.push(text) },
      textService: {
        translate: async (request) => {
          requests.push(['translate', request]);
          return '测试翻译';
        },
        explain: async (request) => {
          requests.push(['explain', request]);
          return '测试解释';
        }
      }
    }
  });
  runtime.register(manifest, createSelectionPlugin);
  await runtime.start(manifest.id);

  assert.deepEqual(
    await runtime.execute(manifest.id, 'copy', { selection: '  source  ' }),
    { action: 'copy', text: 'source', copied: true }
  );
  assert.equal(
    (await runtime.execute(manifest.id, 'translate', {
      selection: 'source',
      targetLanguage: 'zh-CN'
    })).result,
    '测试翻译'
  );
  assert.equal(
    (await runtime.execute(manifest.id, 'explain', {
      selection: 'source',
      locale: 'zh-CN'
    })).result,
    '测试解释'
  );
  assert.deepEqual(clipboard, ['source']);
  assert.equal(requests.length, 2);
});

test('selection plugin refuses empty input', async () => {
  const runtime = createPluginRuntime({
    ports: { clipboard: { writeText: async () => {} } }
  });
  runtime.register(manifest, createSelectionPlugin);
  await runtime.start(manifest.id);
  await assert.rejects(
    runtime.execute(manifest.id, 'copy', { selection: '   ' }),
    (error) => error.code === 'SELECTION_REQUIRED'
  );
});
