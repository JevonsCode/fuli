import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConnectorCatalog } from '../src/external-knowledge/catalog.js';

test('connector catalog ships protocol, service, retrieval API, and trusted-code adapters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-connector-catalog-'));
  try {
    const catalog = createConnectorCatalog({ customConnectorDirectory: directory });
    assert.deepEqual(catalog.list().map(({ type }) => type), [
      'mcp', 'notion', 'feishu', 'retrieval_api', 'custom'
    ]);
    assert.equal(catalog.get('mcp').type, 'mcp');
    assert.equal(catalog.get('missing'), null);
    assert.equal(
      catalog.list().find(({ type }) => type === 'custom').trust,
      'trusted_local_code'
    );
    assert.equal(
      catalog.list().find(({ type }) => type === 'retrieval_api').trust,
      'compatible_read_api'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
