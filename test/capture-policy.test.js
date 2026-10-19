import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CapturePolicyStore,
  capturePolicyPathForRuntime
} from '../src/graphiti/capture-policy.js';
import { writeFileSync } from 'node:fs';
import { checkpointConversation } from '../src/graphiti/agent-conversations.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';

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
  // An absolute host path: the policy path is resolved, so a POSIX literal is not absolute on Windows.
  const runtimeDirectory = join(tmpdir(), 'fuli-runtime');
  assert.equal(
    capturePolicyPathForRuntime(join(runtimeDirectory, 'graph-runtime.json')),
    join(runtimeDirectory, 'capture-policy.json')
  );
});

test('one client can stop being captured while every client keeps using FULI', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-sources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const store = new CapturePolicyStore(path, { now: () => '2026-10-18T00:00:00.000Z' });
  const app = { getCapturePolicy: () => store.read() };
  assert.deepEqual(store.update({ enabled: true, disabledSources: ['codex'] }).disabledSources, ['codex']);
  assert.deepEqual(captureDecision(app, { sourceApplication: 'codex' }), { allowed: false, reason: 'client_off', layer: 'client' });
  assert.equal(captureDecision(app, { sourceApplication: 'claude_code' }).allowed, true);
  assert.equal(captureDecision(app).allowed, true);
  // A later global toggle keeps the per-client choice unless it is sent again.
  assert.deepEqual(store.update({ enabled: false }).disabledSources, ['codex']);
  assert.equal(captureDecision(app, { sourceApplication: 'claude_code' }).reason, 'global_off');
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
    getCapturePolicy: () => ({ enabled: true, disabledSources: ['codex'] }),
    personal: { conversation: async (operation, input) => { saved.push(input.source_application); return { status: 'saved', conversation_id: 'c' }; },
      getProjectAgent: async () => ({ profile: { name: 'Lead' } }) } };
  const task = { token: 't', projectAgentId: 'lead', personalProjectId: 'p', sessionId: 's' };
  const log = { status: 'completed', summary: 'done' };
  assert.deepEqual(await checkpointConversation(application, { ...task, sourceApplication: 'codex' }, log),
    { status: 'capture_disabled', reason: 'client_off', layer: 'client' });
  assert.equal((await checkpointConversation(application, { ...task, sourceApplication: 'claude_code' }, log)).status, 'saved');
  assert.deepEqual(saved, ['claude_code']);
});
test('the policy file is parsed again only when it changes, and a corrupt file is never served from cache', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  let parses = 0;
  const store = new CapturePolicyStore(path, { readText: file => { parses += 1; return readFileSync(file, 'utf8'); } });
  const writer = new CapturePolicyStore(path);
  writer.update({ enabled: true, disabledSources: [] });
  assert.equal(store.read().enabled, true);
  assert.equal(store.read().enabled, true);
  assert.equal(parses, 1, 'an unchanged file is not parsed again');
  writer.update({ enabled: false, disabledSources: ['codex'] });
  assert.deepEqual([store.read().enabled, store.read().disabledSources], [false, ['codex']]);
  assert.equal(parses, 2, 'another process changing the file is seen at once');
  writeFileSync(path, '{ not json');
  assert.throws(() => store.read(), /could not be read/);
  assert.throws(() => store.read(), /could not be read/, 'a corrupt file stays unavailable');
  assert.equal(captureDecision({ getCapturePolicy: () => store.read() }).reason, 'policy_unavailable');
  writer.update({ enabled: true, disabledSources: [] });
  assert.equal(store.read().enabled, true);
  rmSync(path);
  assert.deepEqual(store.read(), { enabled: true, disabledSources: [], updatedAt: null });
});
