import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareDirectAgentToolCall } from '../src/mcp/direct-call.js';

test('direct calls validate the same public tool schema before application I/O', async () => {
  await assert.rejects(
    prepareDirectAgentToolCall({
      toolName: 'submit_project_agent_task',
      input: {},
      hostSessionId: 'fuli-host-direct-test'
    }),
    /Input validation error/
  );
  await assert.rejects(
    prepareDirectAgentToolCall({
      toolName: 'not_a_fuli_tool',
      input: {}
    }),
    /Unknown tool/
  );
});

test('direct employee calls replace caller attribution and cannot self-verify', async () => {
  const base = {
    projectPath: '/synthetic/project', templateId: 'jefa',
    tool: 'review_candidates', arguments: {}
  };
  await assert.rejects(prepareDirectAgentToolCall({
    toolName: 'call_employee_tool',
    input: {
      ...base,
      sourceApplication: 'codex',
      sourceSessionId: 'forged-session',
      sourceSessionVerified: true
    },
    sourceApplication: 'other',
    hostSessionId: 'fuli-host-direct-test'
  }), /Input validation error/);
  const prepared = await prepareDirectAgentToolCall({
    toolName: 'call_employee_tool', input: base,
    sourceApplication: 'other', hostSessionId: 'fuli-host-direct-test'
  });

  assert.equal(prepared.input.sourceApplication, 'other');
  assert.equal(prepared.input.sourceSessionId, 'fuli-host-direct-test');
  assert.equal(prepared.input.sourceSessionVerified, false);
});

test('direct Codex calls verify only the native host thread identity', async () => {
  const threadId = '019fc6ed-02a5-7832-8821-68e3b03e7ce3';
  const prepared = await prepareDirectAgentToolCall({
    toolName: 'call_employee_tool',
    input: {
      projectPath: '/synthetic/project', templateId: 'jefa',
      tool: 'review_candidates', arguments: {}
    },
    sourceApplication: 'codex',
    env: { CODEX_THREAD_ID: threadId }
  });

  assert.equal(prepared.input.sourceApplication, 'codex');
  assert.equal(prepared.input.sourceSessionId, threadId);
  assert.equal(prepared.input.sourceSessionVerified, true);
});

test('direct calls apply the MCP input budget and array lengths before validation', async () => {
  const call = (input) => prepareDirectAgentToolCall({
    toolName: 'get_collaboration_preferences', input, hostSessionId: 'fuli-host-direct-test'
  });
  await assert.rejects(call({ projectPath: '/synthetic/project', workKind: Array(50_000).fill('x') }),
    /Invalid tool arguments: more than the maximum of 50000 elements/);
  await assert.rejects(call({ projectPath: '/synthetic/project', requiredCapabilities: Array(25_000).fill({}) }),
    /Invalid tool arguments: arguments\.requiredCapabilities has more than the maximum of 16 items/);
  const prepared = await call({ projectPath: '/synthetic/project' });
  assert.equal(prepared.input.projectPath, '/synthetic/project');
});
