import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentAccessPolicyStore,
  agentAccessPolicyPathForRuntime
} from '../src/graphiti/agent-access-policy.js';

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
