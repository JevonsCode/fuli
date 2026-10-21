import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentAccessPolicyStore,
  agentAccessPolicyPathForRuntime
} from '../src/graphiti/agent-access-policy.js';
import { writeWhileReaderHoldsOpen } from '../test-support/open-file-reader.js';
import { refusesRenameOverOpenFile } from '../test-support/platform-capabilities.js';

test('Agent access defaults to enabled and is shared across runtime processes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-agent-access-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'agent-access-policy.json');
  const first = new AgentAccessPolicyStore(path, {
    now: () => '2026-07-28T10:00:00.000Z'
  });
  const second = new AgentAccessPolicyStore(path);

  assert.deepEqual(first.read(), { enabled: true, updatedAt: null });
  assert.deepEqual(first.update({ enabled: false }), {
    enabled: false,
    updatedAt: '2026-07-28T10:00:00.000Z'
  });
  assert.deepEqual(second.read(), {
    enabled: false,
    updatedAt: '2026-07-28T10:00:00.000Z'
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('Agent access is saved while another process is reading the policy', refusesRenameOverOpenFile, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-agent-access-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'agent-access-policy.json');
  const store = new AgentAccessPolicyStore(path);
  store.update({ enabled: false });

  await writeWhileReaderHoldsOpen(path, () => store.update({ enabled: true }));

  assert.equal(new AgentAccessPolicyStore(path).read().enabled, true);
});

test('Agent access never overwrites a policy a newer FULI wrote', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-agent-access-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'agent-access-policy.json');
  const newer = '{"version":2,"enabled":true,"updatedAt":null}\n';
  writeFileSync(path, newer);

  assert.throws(() => new AgentAccessPolicyStore(path).update({ enabled: false }), { code: 'data_format_blocked' });
  assert.equal(readFileSync(path, 'utf8'), newer);
});

test('Agent access accepts only an explicit boolean', () => {
  const store = new AgentAccessPolicyStore();
  assert.throws(() => store.update({ enabled: 'false' }), /must be a boolean/);
  assert.throws(() => store.update({}), /must be a boolean/);
});

test('Agent access policy lives beside the shared graph runtime configuration', () => {
  // An absolute host path: the policy path is resolved, so a POSIX literal is not absolute on Windows.
  const runtimeDirectory = join(tmpdir(), 'fuli-runtime');
  assert.equal(
    agentAccessPolicyPathForRuntime(join(runtimeDirectory, 'graph-runtime.json')),
    join(runtimeDirectory, 'agent-access-policy.json')
  );
});
