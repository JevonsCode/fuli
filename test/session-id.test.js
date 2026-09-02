import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mcpHostSessionId,
  nativeCodexThreadId,
  normalizeAgentSessionInput,
  normalizeMcpSourceApplication
} from '../src/mcp/session-id.js';

const NATIVE_THREAD_ID = '019fc6ed-02a5-7832-8821-68e3b03e7ce3';

test('Claude remote connector has distinct authoritative client attribution', () => {
  assert.equal(normalizeMcpSourceApplication('claude'), 'claude');
});

test('employee tool calls receive host-bound native session identity, never caller attribution', () => {
  const actual = normalizeAgentSessionInput('call_employee_tool', {
    templateId: 'jefa', sourceApplication: 'other', sourceSessionId: 'forged-session', sourceSessionVerified: false,
  }, NATIVE_THREAD_ID);
  assert.equal(actual.sourceApplication, 'codex');
  assert.equal(actual.sourceSessionId, NATIVE_THREAD_ID);
  assert.equal(actual.sourceSessionVerified, true);
  assert.equal(normalizeAgentSessionInput('call_employee_tool', { sourceSessionVerified: true }, null, 'fuli-host-test').sourceSessionVerified, false);
});

test('Codex MCP uses the native thread UUID for session-bearing tools', () => {
  assert.equal(nativeCodexThreadId({ CODEX_THREAD_ID: NATIVE_THREAD_ID }), NATIVE_THREAD_ID);
  assert.deepEqual(
    normalizeAgentSessionInput(
      'capture_session_knowledge',
      { sessionId: 'codex-fuli-ui-status-dedup-20260723', sourceApplication: 'codex' },
      NATIVE_THREAD_ID
    ),
    {
      sessionId: NATIVE_THREAD_ID, sourceApplication: 'codex',
      sourceSessionId: NATIVE_THREAD_ID
    }
  );
  assert.deepEqual(
    normalizeAgentSessionInput(
      'begin_task_context',
      { sessionId: 'custom-task-name', projectPath: '/workspace/fuli' },
      NATIVE_THREAD_ID
    ),
    {
      sessionId: NATIVE_THREAD_ID, projectPath: '/workspace/fuli',
      sourceApplication: 'codex', sourceSessionId: NATIVE_THREAD_ID
    }
  );
});

test('Codex MCP canonicalizes whitespace-padded native thread IDs', () => {
  assert.deepEqual(
    normalizeAgentSessionInput(
      'capture_session_knowledge',
      { sessionId: `  ${NATIVE_THREAD_ID}  ` },
      NATIVE_THREAD_ID
    ),
    {
      sessionId: NATIVE_THREAD_ID, sourceApplication: 'codex',
      sourceSessionId: NATIVE_THREAD_ID
    }
  );
});

test('invalid or absent Codex thread IDs never replace supplied session IDs', () => {
  assert.equal(nativeCodexThreadId({ CODEX_THREAD_ID: 'codex-task-name' }), null);
  const input = { sessionId: 'session-1' };
  assert.deepEqual(
    normalizeAgentSessionInput(
      'capture_session_knowledge', input, null, 'fuli-host-test'
    ),
    {
      sessionId: 'session-1', sourceApplication: 'other',
      sourceSessionId: 'fuli-host-test'
    }
  );
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
    workflowKey: 'release-notes-link-check', sourceApplication: 'other',
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

test('task activity keeps worker runtime separate from host-authoritative source', () => {
  const workerRuntime = { application: 'claude_code', sessionId: 'worker-session' };
  assert.deepEqual(
    normalizeAgentSessionInput(
      'record_project_agent_task_activity',
      {
        sourceApplication: 'codex',
        sourceSessionId: 'forged-session',
        workerId: 'worker-1',
        workerLabel: 'worker label',
        workerRuntime
      },
      null,
      'cursor-host-session',
      () => new Date('2026-08-17T00:00:00Z'),
      'cursor'
    ),
    {
      workerId: 'worker-1',
      workerLabel: 'worker label',
      workerRuntime,
      sourceApplication: 'cursor',
      sourceSessionId: 'cursor-host-session'
    }
  );
});

test('knowledge writes and workflow observations cannot forge client attribution', () => {
  assert.deepEqual(
    normalizeAgentSessionInput(
      'capture_session_knowledge',
      {
        sessionId: 'claude-conversation', sourceApplication: 'codex',
        sourceSessionId: 'forged-host', name: 'bounded capture'
      },
      null,
      'claude-host-session',
      () => new Date('2026-08-17T00:00:00Z'),
      'claude_code'
    ),
    {
      sessionId: 'claude-conversation', name: 'bounded capture',
      sourceApplication: 'claude_code', sourceSessionId: 'claude-host-session'
    }
  );
  assert.deepEqual(
    normalizeAgentSessionInput(
      'record_workflow_transition_observation',
      { workflowKey: 'release', sourceApplication: 'codex' },
      null,
      'cursor-host-session',
      () => new Date('2026-08-17T00:00:00Z'),
      'cursor'
    ),
    {
      workflowKey: 'release', sourceApplication: 'cursor',
      hostSessionId: 'cursor-host-session',
      hostObservedAt: '2026-08-17T00:00:00.000Z'
    }
  );
});

test('host-bound normalization strips camelCase and snake_case trust aliases', () => {
  const project = normalizeAgentSessionInput(
    'call_employee_tool',
    {
      sourceSessionVerified: true,
      source_session_verified: true,
      source_application: 'codex',
      source_session_id: 'forged-session'
    },
    null,
    'claude-host-session',
    () => new Date('2026-08-17T00:00:00Z'),
    'claude_code'
  );
  assert.equal(project.sourceSessionVerified, false);
  assert.equal('source_session_verified' in project, false);

  const observation = normalizeAgentSessionInput(
    'record_workflow_transition_observation',
    {
      workflowKey: 'release',
      session_id: 'forged-session',
      idempotency_key: 'forged-key',
      observed_at: '2099-01-01T00:00:00Z',
      host_session_id: 'forged-host',
      host_observed_at: '2099-01-01T00:00:00Z',
      source_session_verified: true
    },
    null,
    'cursor-host-session',
    () => new Date('2026-08-17T00:00:00Z'),
    'cursor'
  );
  assert.deepEqual(observation, {
    workflowKey: 'release', sourceApplication: 'cursor',
    hostSessionId: 'cursor-host-session',
    hostObservedAt: '2026-08-17T00:00:00.000Z'
  });
});
