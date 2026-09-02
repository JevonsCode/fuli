import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderTaskContextRegistry } from '../src/mcp/provider-task-context-registry.js';

function providerRecord(overrides = {}) {
  return {
    token: 'fuli-task-provider-token',
    session_id: 'logical-session',
    personal_project_id: 'project-1',
    project_agent_id: 'agent-1',
    source_application: 'claude_code',
    source_session_id: 'mcp-host-session',
    turn_id: 'turn-1',
    memory_revision: 3,
    agent_memory: null,
    checkpoint: null,
    previous_checkpoint_missing: false,
    ...overrides
  };
}

test('Provider task context records preserve turn and host-session provenance', async () => {
  let received;
  const registry = new ProviderTaskContextRegistry({
    beginTaskContext: async (input) => {
      received = input;
      return {
        ...input,
        checkpoint: null,
        previous_checkpoint_missing: false
      };
    }
  }, 'space-1');

  const result = await registry.begin({
    sessionId: 'logical-session', turnId: 'turn-1', personalProjectId: 'project-1',
    sourceApplication: 'claude_code', sourceSessionId: 'mcp-host-session'
  });

  assert.equal(received.source_session_id, 'mcp-host-session');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.sourceSessionId, 'mcp-host-session');
});

test('Provider preparation forwards Agent memory atomically and completion omits it', async () => {
  const writes = [];
  const registry = new ProviderTaskContextRegistry({
    checkpointTaskContext: async (token, input) => {
      writes.push({ token, input });
      return providerRecord({ checkpoint: input });
    }
  }, 'space-1');
  const checkpoint = {
    disposition: 'retain_nothing',
    reason: 'No durable candidates.',
    fingerprint: 'a'.repeat(64),
    captureStatus: null
  };
  const agentMemory = {
    expected_revision: 3,
    memory: { summary: 'Bounded durable working context.' }
  };

  await registry.prepare(
    'fuli-task-provider-token', checkpoint, 'claude_code', agentMemory
  );
  await registry.checkpoint(
    'fuli-task-provider-token', { ...checkpoint, captureStatus: 'retained' }, 'claude_code'
  );

  assert.equal(writes[0].input.phase, 'prepare');
  assert.equal(writes[0].input.source_application, 'claude_code');
  assert.deepEqual(writes[0].input.agent_memory, agentMemory);
  assert.equal(writes[1].input.phase, 'complete');
  assert.equal(writes[1].input.source_application, 'claude_code');
  assert.equal('agent_memory' in writes[1].input, false);
});

test('Provider context and verification preserve source isolation', async () => {
  const calls = [];
  const registry = new ProviderTaskContextRegistry({
    getTaskContext: async (token, input) => {
      calls.push({ method: 'context', token, input });
      return providerRecord();
    },
    verifyTaskCheckpoint: async (input) => {
      calls.push({ method: 'verify', input });
      return { status: 'checkpoint_required' };
    }
  }, 'space-1');

  await registry.context('fuli-task-provider-token', 'cursor');
  await registry.verify('logical-session', 'cursor');

  assert.equal(calls[0].input.source_application, 'cursor');
  assert.equal(calls[1].input.source_application, 'cursor');
});

test('Provider registry rejects malformed durable task records', async () => {
  const registry = new ProviderTaskContextRegistry({
    getTaskContext: async () => ({ token: null, session_id: null })
  }, 'space-1');

  await assert.rejects(
    registry.context('fuli-task-provider-token', 'codex'),
    /Provider did not return a durable task context/
  );
});
