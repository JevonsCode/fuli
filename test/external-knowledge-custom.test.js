import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCustomConnector } from '../src/external-knowledge/connectors/custom.js';

test('custom connector loads a trusted local ESM module inside its configured directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-custom-connector-'));
  writeFileSync(join(directory, 'fixture.mjs'), `
    export default {
      async check() { return { status: 'ready' } },
      async sync({ source }) {
        return {
          items: [{ id: source.id, title: 'Custom', content: 'custom content' }],
          deleted: [], nextCursor: null, hasMore: false
        }
      },
      async retrieve() { return { items: [] } }
    }
  `);
  const connector = createCustomConnector({ directory });

  try {
    const result = await connector.sync({
      config: { module: 'fixture.mjs', environmentNames: [] },
      source: { id: 'custom-1' },
      env: { UNEXPOSED_SECRET: 'not-passed-through-the-contract' }
    });

    assert.equal(result.items[0].id, 'custom-1');
    await assert.rejects(
      connector.sync({ config: { module: '../outside.mjs' }, source: {}, env: {} }),
      /inside the custom connector directory/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
