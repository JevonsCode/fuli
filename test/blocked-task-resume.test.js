import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { createDelegatedConsoleClient } from '../src/agent-delegation/console-client.js';
import { createAgentDelegation } from '../src/agent-delegation/port.js';
import { callAgentTool } from '../src/agent-tools.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { handleDelegatedRequest } from '../src/http/agent-delegation-gate.js';
import { handleTaskBlockerRequest } from '../src/http/task-blocker-api-router.js';
import { taskBlockerConsole } from '../src/task-blockers/console-port.js';

// rec#123: an FLA that is neither the reporting session nor the lead resumes a
// blocked task with one record_project_agent_task_activity call. Synthetic
// Provider and console; the real delegation gate, its permission and its log.
const REFUSAL = 'blocked -> running needs its reporting session or lead Agent.';

function world({ organisation = true, revision = 3 } = {}) {
  const delegation = createAgentDelegation(null);
  if (!organisation) delegation.setCategory('organisation', false);
  const provider = [];
  const port = taskBlockerConsole('synthetic-data-dir', { send: async (path, body) => {
    provider.push({ path, body });
    return { ok: true, status: 200, payload: { task_id: 'task-a', personal_space_id: 'personal-space',
      personal_project_id: 'project-a', title: 'Synthetic', status: body.resume_status ?? 'running',
      revision: revision + 1, participants: [], events: [] } };
  } });
  const app = {
    config: { personal: { spaceId: 'personal-space' } },
    taskContextRegistry: { context: async () => ({ projectAgentId: 'fla-b', personalProjectId: 'project-a',
      sourceApplication: 'claude_code', sessionId: 'session-b' }) },
    activity: [],
    async recordProjectAgentTaskActivity(input) {
      this.activity.push(input);
      if (this.activity.length === 1) {
        throw new ProviderRequestError(REFUSAL, { status: 409, code: 'task_blocked_elsewhere' });
      }
      return { taskId: 'task-a', status: input.status, revision: revision + 2 };
    },
    async viewProjectAgentTask() { return { taskId: 'task-a', status: 'blocked', revision }; }
  };
  // The console as run_delegated_action reaches it, through the real gate.
  app.delegatedConsole = createDelegatedConsoleClient({ consoleUrl: () => 'http://127.0.0.1:2828',
    fetchImpl: async (url, { method, headers, body }) => {
      const sent = { headers: {} };
      const response = { statusCode: 200, setHeader(name, value) { sent.headers[name] = value; },
        writeHead(status) { this.statusCode = status; }, end(text) { sent.body = text; } };
      const request = Object.assign(Readable.from([Buffer.from(body)]), { method, url: new URL(url).pathname,
        headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
        socket: { remoteAddress: '127.0.0.1' } });
      await handleDelegatedRequest({ request, response, delegation, agentAccessEnabled: () => true,
        handle: () => handleTaskBlockerRequest({ request, response, url: new URL(url), app, blockerConsole: port }) });
      return new Response(sent.body, { status: response.statusCode, headers: sent.headers });
    } });
  return { app, delegation, provider };
}

const report = (changes = {}) => ({ personalSpaceId: 'personal-space', personalProjectId: 'project-a', taskId: 'task-a',
  idempotencyKey: 'resume-1', status: 'running', summary: 'Rotated the expired credential; continuing.',
  agentId: 'fla-b', taskContextToken: 'fuli-task-synthetic', ...changes });

test('a blocked task resumes in one call under the person\'s AI permission, recorded with the Agent and its reason', async () => {
  const { app, delegation, provider } = world();
  const result = await callAgentTool(app, 'record_project_agent_task_activity', report({ expectedRevision: 3 }));
  assert.equal(result.status, 'running');
  assert.deepEqual(result.blockerCleared.by, { agentId: 'fla-b', client: 'claude_code', sessionId: 'session-b' });
  assert.equal(result.blockerCleared.permission, 'Settings › AI permissions › Organisation');
  assert.match(result.blockerCleared.receipt.markdown, /AI 权限 · organisation/);
  // The clear names the FLA and its reason; the report follows on the cleared revision.
  assert.deepEqual(provider, [{ path: '/v1/project-agent-tasks/task-a/blocker/clear', body: {
    personal_space_id: 'personal-space', personal_project_id: 'project-a',
    note: 'Rotated the expired credential; continuing.', cleared_by: 'agent', agent_id: 'fla-b',
    source_application: 'claude_code', source_session_id: 'session-b', resume_status: 'running' } }]);
  assert.equal(app.activity.length, 2);
  assert.equal(app.activity[1].expectedRevision, 4);
  const [operation] = delegation.read().operations;
  assert.equal(operation.route, 'POST /api/project-agent-tasks/:taskId/blocker/clear');
  assert.equal(operation.actor.agentId, 'fla-b');
  assert.equal(result.blockerCleared.operationId, operation.id);
});

test('a report asking for queued puts the cleared task back in its queue', async () => {
  const { app, provider } = world();
  const result = await callAgentTool(app, 'record_project_agent_task_activity', report({ status: 'queued' }));
  assert.equal(provider[0].body.resume_status, 'queued');
  assert.equal(result.blockerCleared.resumedAs, 'queued');
  assert.equal(app.activity[1].expectedRevision, undefined);
});

test('with the Organisation permission off nothing is cleared and the refusal names the switch', async () => {
  const { app, delegation, provider } = world({ organisation: false });
  await assert.rejects(callAgentTool(app, 'record_project_agent_task_activity', report()), (error) => {
    assert.equal(error.code, 'delegation_category_off');
    assert.match(error.message, /not cleared and the report was not recorded/);
    assert.match(error.message, /设置 › AI 权限 › 组织/);
    assert.match(error.message, /Settings › AI permissions › Organisation/);
    return true;
  });
  assert.deepEqual(provider, []);
  assert.equal(app.activity.length, 1);
  assert.deepEqual(delegation.read().operations, []);
});

test('no clear without the calling task, for a stale report, or for other statuses and refusals', async () => {
  const tokenless = world();
  await assert.rejects(callAgentTool(tokenless.app, 'record_project_agent_task_activity',
    report({ taskContextToken: undefined })), /Resend with your taskContextToken/);
  const stale = world({ revision: 5 });
  await assert.rejects(callAgentTool(stale.app, 'record_project_agent_task_activity', report({ expectedRevision: 3 })),
    (error) => error.code === 'task_revision_stale');
  const completing = world();
  await assert.rejects(callAgentTool(completing.app, 'record_project_agent_task_activity', report({ status: 'completed' })),
    (error) => error.code === 'task_blocked_elsewhere');
  for (const { provider } of [tokenless, stale, completing]) assert.deepEqual(provider, []);
});
