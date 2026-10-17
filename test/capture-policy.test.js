import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CapturePolicyStore,
  capturePolicyFor,
  capturePolicyPathForRuntime
} from '../src/graphiti/capture-policy.js';
import { writeFileSync } from 'node:fs';
import { checkpointConversation } from '../src/graphiti/agent-conversations.js';

test('capture policy defaults to enabled and is shared across runtime processes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const first = new CapturePolicyStore(path, { now: () => '2026-07-22T10:00:00.000Z' });
  const second = new CapturePolicyStore(path);

  assert.deepEqual(first.read(), { enabled: true, disabledSources: [], updatedAt: null });
  assert.deepEqual(first.update({ enabled: false }), {
    enabled: false,
    disabledSources: [],
    updatedAt: '2026-07-22T10:00:00.000Z'
  });
  assert.deepEqual(second.read(), {
    enabled: false,
    disabledSources: [],
    updatedAt: '2026-07-22T10:00:00.000Z'
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('capture policy accepts only an explicit boolean', () => {
  const store = new CapturePolicyStore();
  assert.throws(() => store.update({ enabled: 'false' }), /must be a boolean/);
  assert.throws(() => store.update({}), /must be a boolean/);
});

test('capture policy lives beside the shared graph runtime configuration', () => {
  assert.equal(
    capturePolicyPathForRuntime('/data/fuli/graph-runtime.json'),
    '/data/fuli/capture-policy.json'
  );
});

test('one client can stop being captured while every client keeps using FULI', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-sources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const store = new CapturePolicyStore(path, { now: () => '2026-10-18T00:00:00.000Z' });
  const policy = store.update({ enabled: true, disabledSources: ['codex'] });
  assert.deepEqual(policy.disabledSources, ['codex']);
  assert.equal(capturePolicyFor(policy, 'codex').enabled, false);
  assert.equal(capturePolicyFor(policy, 'codex').disabledFor, 'codex');
  assert.equal(capturePolicyFor(policy, 'claude_code').enabled, true);
  assert.equal(capturePolicyFor(policy).enabled, true);
  // A later global toggle keeps the per-client choice unless it is sent again.
  assert.deepEqual(store.update({ enabled: false }).disabledSources, ['codex']);
  assert.equal(capturePolicyFor(store.read(), 'claude_code').enabled, false);
  assert.throws(() => store.update({ enabled: true, disabledSources: ['unknown'] }), /distinct supported clients/);
  assert.throws(() => store.update({ enabled: true, disabledSources: ['codex', 'codex'] }), /distinct supported clients/);
});

test('policies saved before per-client capture still capture every client', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-legacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  writeFileSync(path, JSON.stringify({ version: 1, enabled: true, updatedAt: null }));
  assert.deepEqual(new CapturePolicyStore(path).read().disabledSources, []);
});

test('a disabled client saves no conversation while the others still do', async () => {
  const saved = [];
  const application = { config: { personal: { spaceId: 'space' } },
    getCapturePolicy: source => capturePolicyFor({ enabled: true, disabledSources: ['codex'] }, source),
    personal: { conversation: async (operation, input) => { saved.push(input.source_application); return { status: 'saved', conversation_id: 'c' }; },
      getProjectAgent: async () => ({ profile: { name: 'Lead' } }) } };
  const task = { token: 't', projectAgentId: 'lead', personalProjectId: 'p', sessionId: 's' };
  const log = { status: 'completed', summary: 'done' };
  assert.deepEqual(await checkpointConversation(application, { ...task, sourceApplication: 'codex' }, log),
    { status: 'capture_disabled' });
  assert.equal((await checkpointConversation(application, { ...task, sourceApplication: 'claude_code' }, log)).status, 'saved');
  assert.deepEqual(saved, ['claude_code']);
});