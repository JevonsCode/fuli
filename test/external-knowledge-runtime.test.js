import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openExternalKnowledgeRuntime } from '../src/external-knowledge/runtime.js';
import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('external knowledge runtime wires persistent bindings, connectors, and connected search', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-runtime-'));
  const paths = {
    externalKnowledgeRegistryPath: join(directory, 'bindings.json'),
    externalKnowledgeConflictPolicyPath: join(directory, 'conflicts.json'),
    externalKnowledgeConnectorDir: join(directory, 'connectors')
  };
  const app = {
    searchKnowledge: async () => ({ facts: [], entities: [] }),
    listPersonalProjects: async () => []
  };

  try {
    const runtime = openExternalKnowledgeRuntime({ app, paths, env: {} });
    assert.ok(runtime.externalKnowledge);
    assert.ok(runtime.connectedKnowledge);
    assert.deepEqual(runtime.externalKnowledge.listConnectorTypes().map(({ type }) => type), [
      'mcp', 'notion', 'feishu', 'retrieval_api', 'custom'
    ]);
    assert.equal(existsSync(paths.externalKnowledgeConnectorDir), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the normal Graphiti application factory attaches external knowledge beside the runtime config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-external-attachment-'));
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'test-token',
      principalId: 'person-1',
      spaceId: 'personal-1'
    },
    workspaces: []
  }));

  try {
    const app = openFederatedGraphApplication({ runtimeConfigPath, env: {} });
    assert.ok(app.externalKnowledge);
    assert.ok(app.connectedKnowledge);
    assert.equal(
      existsSync(join(directory, 'external-knowledge', 'connectors')),
      true
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
