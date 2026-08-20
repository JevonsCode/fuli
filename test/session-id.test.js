import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mcpHostSessionId,
  nativeCodexThreadId,
  normalizeAgentSessionInput
} from '../src/mcp/session-id.js';

const NATIVE_THREAD_ID = '019fc6ed-02a5-7832-8821-68e3b03e7ce3';

test('Codex MCP uses the native thread UUID for session-bearing tools', () => {
  assert.equal(nativeCodexThreadId({ CODEX_THREAD_ID: NATIVE_THREAD_ID }), NATIVE_THREAD_ID);
  assert.deepEqual(
    normalizeAgentSessionInput(
      'capture_session_knowledge',
      { sessionId: 'codex-fuli-ui-status-dedup-20260723', sourceApplication: 'codex' },
      NATIVE_THREAD_ID
    ),
    { sessionId: NATIVE_THREAD_ID, sourceApplication: 'codex' }
  );
  assert.deepEqual(
    normalizeAgentSessionInput(
      'begin_task_context',
      { sessionId: 'custom-task-name', projectPath: '/workspace/fuli' },
      NATIVE_THREAD_ID
    ),
    { sessionId: NATIVE_THREAD_ID, projectPath: '/workspace/fuli' }
  );
});

test('invalid or absent Codex thread IDs never replace supplied session IDs', () => {
  assert.equal(nativeCodexThreadId({ CODEX_THREAD_ID: 'codex-task-name' }), null);
  const input = { sessionId: 'session-1' };
  assert.equal(normalizeAgentSessionInput('capture_session_knowledge', input, null), input);
  assert.equal(
    normalizeAgentSessionInput('search_knowledge_graph', input, NATIVE_THREAD_ID),
    input
  );
});

test('workflow observations replace every Agent session and timestamp with host values', () => {
  const hostSessionId = mcpHostSessionId({}, () => 'process-session-1');
  assert.equal(hostSessionId, 'fuli-host-process-session-1');
  const clock = () => new Date('2026-08-03T08:00:00Z');
  const normalized = ['fake-session-1', 'fake-session-2', 'fake-session-3'].map(
    (sessionId) => normalizeAgentSessionInput(
      'record_workflow_transition_observation',
      {
        workflowKey: 'release-notes-link-check',
        sessionId,
        idempotencyKey: `fake-${sessionId}`,
        observedAt: '2099-01-01T00:00:00Z'
      },
      null,
      hostSessionId,
      clock
    )
  );

  assert.deepEqual(normalized, [0, 1, 2].map(() => ({
    workflowKey: 'release-notes-link-check',
    hostSessionId: 'fuli-host-process-session-1',
    hostObservedAt: '2026-08-03T08:00:00.000Z'
  })));
});

test('Project Agent MCP calls replace forged client and session attribution', () => {
  const forged = {
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    idempotencyKey: 'task-request-1',
    sourceApplication: 'codex',
    sourceSessionId: 'forged-session'
  };

  assert.deepEqual(
    normalizeAgentSessionInput(
      'submit_project_agent_task',
      forged,
      null,
      'claude-host-session',
      () => new Date('2026-08-17T00:00:00Z'),
      'claude_code'
    ),
    {
      ...forged,
      sourceApplication: 'claude_code',
      sourceSessionId: 'claude-host-session'
    }
  );
  assert.deepEqual(
    normalizeAgentSessionInput(
      'coordinate_project_agent_task',
      { projectPath: '/workspace/fuli' },
      null,
      'codex-host-session',
      () => new Date('2026-08-17T00:00:00Z'),
      'codex'
    ),
    {
      projectPath: '/workspace/fuli',
      sourceApplication: 'codex',
      sourceSessionId: 'codex-host-session'
    }
  );
});

test('task activity source attribution stays host-authoritative with worker fields', () => {
  assert.deepEqual(
    normalizeAgentSessionInput(
      'record_project_agent_task_activity',
      {
        sourceApplication: 'codex',
        sourceSessionId: 'forged-session',
        workerId: 'worker-1',
        workerLabel: 'worker label'
      },
      null,
      'cursor-host-session',
      () => new Date('2026-08-17T00:00:00Z'),
      'cursor'
    ),
    {
      workerId: 'worker-1',
      workerLabel: 'worker label',
      sourceApplication: 'cursor',
      sourceSessionId: 'cursor-host-session'
    }
  );
});
