import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import connector from '../examples/external-knowledge/markdown-folder.mjs';

test('Markdown folder example keeps stable root-relative ids and retrieves file content read-only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-markdown-connector-'));
  mkdirSync(join(directory, 'guide'));
  writeFileSync(join(directory, 'guide', 'start.md'), '# Start here\n\nUse read-only retrieval.');
  const source = { roots: [{ id: 'handbook', path: directory }] };

  try {
    const checked = await connector.check({ source });
    const synced = await connector.sync({ source, cursor: null, limit: 10 });
    const retrieved = await connector.retrieve({
      source,
      query: 'read-only retrieval',
      limit: 10
    });

    assert.deepEqual(checked.roots, ['handbook']);
    assert.equal(synced.items[0].id, 'handbook:guide/start.md');
    assert.equal(synced.items[0].title, 'Start here');
    assert.equal(synced.items[0].metadata.relativePath, 'guide/start.md');
    assert.equal(retrieved.items[0].id, 'handbook:guide/start.md');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
