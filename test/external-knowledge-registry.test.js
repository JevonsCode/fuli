import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ExternalKnowledgeRegistry } from '../src/external-knowledge/index.js';

test('a registry written by a newer FULI is neither read nor overwritten', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-newer-'));
  const file = join(directory, 'bindings.json');
  const newer = JSON.stringify({ version: 3, bindings: [] });
  writeFileSync(file, newer);
  try {
    const registry = new ExternalKnowledgeRegistry(file);
    assert.throws(() => registry.list(), { code: 'data_format_blocked', message: /Upgrade FULI/ });
    assert.throws(() => registry.put({ id: 'binding-1', targets: [] }), { code: 'data_format_blocked' });
    assert.equal(readFileSync(file, 'utf8'), newer);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('registry mutation reservation excludes another instance and releases on failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new ExternalKnowledgeRegistry(join(directory, 'bindings.json'));
  const second = new ExternalKnowledgeRegistry(join(directory, 'bindings.json'));
  let release;
  const pending = first.withMutation(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(second.withMutation(() => assert.fail('must not enter')), { code: 'external_knowledge_busy' });
  release();
  await pending;
  await assert.rejects(first.withMutation(() => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(await second.withMutation(() => 'released'), 'released');
});

test('a v1 registry reads as v2 targets without data loss, and its rewrite waits for a person', () => {
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

    // rec#17 D-09: restructuring stored bindings is a confirmed migration.
    const before = readFileSync(file, 'utf8');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(() => registry.put(binding), { code: 'data_format_pending', store: 'external-knowledge',
        message: /external-knowledge\/2-binding-targets/ });
    }
    assert.throws(() => registry.delete('binding-1'), { code: 'data_format_pending' });
    assert.equal(readFileSync(file, 'utf8'), before);
    const ledger = JSON.parse(readFileSync(`${file}.format-ledger.json`, 'utf8'));
    assert.deepEqual(ledger.events.map(({ migrationId, status, fromVersion, toVersion }) =>
      [migrationId, status, fromVersion, toVersion]), [['external-knowledge/2-binding-targets', 'pending_confirmation', 1, 2]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
