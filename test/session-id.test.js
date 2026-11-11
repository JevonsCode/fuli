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

test('message status and cancel use the trusted host client exactly like message_agent', () => {
  for (const name of ['message_agent', 'get_agent_message_status', 'cancel_agent_message']) {
    for (const [nativeThreadId, host, client] of [[NATIVE_THREAD_ID, NATIVE_THREAD_ID, 'codex'], [null, 'claude-host', 'claude_code']]) {
      const forged = { taskContextToken: 'fuli-task-synthetic', messageId: 'message-1',
        sourceApplication: 'cursor', source_application: 'cursor', sourceSessionId: 'forged' };
      const actual = normalizeAgentSessionInput(name, forged, nativeThreadId, host, client);
      assert.equal(actual.sourceApplication, client, name);
      assert.equal(actual.sourceSessionId, host, name);
      assert.equal('source_application' in actual, false, name);
    }
  }
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
  assert.deepEqual(
    normalizeAgentSessionInput('search_knowledge_graph', input, NATIVE_THREAD_ID),
    { ...input, sourceApplication: 'codex', sourceSessionId: NATIVE_THREAD_ID }
  );
});

test('read-only expansion attribution comes from the native host, never search arguments', () => {
  const actual = normalizeAgentSessionInput('search_knowledge_graph', {
    query: 'Synthetic lookup', sourceApplication: 'cursor', sourceSessionId: 'forged-source',
    source_session_id: 'forged-source', sourceSessionVerified: true,
  }, NATIVE_THREAD_ID);
  assert.equal(actual.sourceApplication, 'codex');
  assert.equal(actual.sourceSessionId, NATIVE_THREAD_ID);
  assert.equal('source_session_id' in actual, false);
  assert.equal('sourceSessionVerified' in actual, false);
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

test('knowledge writes cannot forge client attribution', () => {
  assert.deepEqual(
    normalizeAgentSessionInput(
      'capture_session_knowledge',
      {
        sessionId: 'claude-conversation', sourceApplication: 'codex',
        sourceSessionId: 'forged-host', name: 'bounded capture'
      },
      null,
      'claude-host-session',
      'claude_code'
    ),
    {
      sessionId: 'claude-conversation', name: 'bounded capture',
      sourceApplication: 'claude_code', sourceSessionId: 'claude-host-session'
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
    'claude_code'
  );
  assert.equal(project.sourceSessionVerified, false);
  assert.equal('source_session_verified' in project, false);
});

test('a process without a client session gets a FULI host session id', () => {
  assert.equal(mcpHostSessionId({}, () => 'process-session-1'), 'fuli-host-process-session-1');
});

test('capture-gated tools carry the MCP client, so a client switched off cannot be forged around', () => {
  for (const name of ['record_knowledge_usage', 'record_knowledge_feedback', 'revise_personal_knowledge',
    'upsert_personal_project', 'get_knowledge_graph', 'search_current_project_knowledge']) {
    for (const forged of [{}, { sourceApplication: 'other' }]) {
      assert.equal(normalizeAgentSessionInput(name, { personalSpaceId: 'synthetic-space', ...forged },
        null, 'claude-host', 'claude_code').sourceApplication, 'claude_code', name);
    }
  }
});
