import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ExternalKnowledgeRegistry } from '../src/external-knowledge/index.js';

test('registry migrates a v1 single-project binding to v2 target state without data loss', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-registry-'));
  const file = join(directory, 'bindings.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    bindings: [{
      id: 'binding-1',
      name: 'LLM Wiki',
      connectorType: 'mcp',
      connectorConfig: { tokenEnv: 'LLM_WIKI_TOKEN' },
      source: { resourceUriPrefix: 'llm-wiki://' },
      target: {
        personalSpaceId: 'personal-space',
        personalProjectId: 'fuli'
      },
      mode: 'live',
      status: 'ready',
      capabilities: ['retrieve'],
      sync: {
        cursor: null,
        lastSyncedAt: null,
        error: null,
        skippedCredentials: 0,
        items: {}
      }
    }]
  }));

  try {
    const registry = new ExternalKnowledgeRegistry(file);
    const binding = registry.list()[0];
    assert.equal(binding.targets.length, 1);
    assert.deepEqual(binding.targets[0], {
      id: 'binding-1',
      personalSpaceId: 'personal-space',
      personalProjectId: 'fuli',
      mode: 'live',
      status: 'ready',
      sync: {
        cursor: null,
        lastSyncedAt: null,
        error: null,
        skippedCredentials: 0,
        items: {}
      }
    });
    assert.equal(binding.target, undefined);
    assert.equal(binding.connectorConfig.tokenEnv, 'LLM_WIKI_TOKEN');

    registry.put(binding);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
