import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createDelegatedConsoleClient } from '../src/agent-delegation/console-client.js';
import { createAgentDelegation } from '../src/agent-delegation/port.js';
import { callAgentTool } from '../src/agent-tools.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { handleDelegatedRequest } from '../src/http/agent-delegation-gate.js';
import { handleTaskBlockerRequest } from '../src/http/task-blocker-api-router.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { taskBlockerConsole } from '../src/task-blockers/console-port.js';

// rec#123: an FLA that is neither the reporting session nor the lead resumes a
// blocked task with one record_project_agent_task_activity call. Synthetic
// Provider and console; the real delegation gate, its permission and its log.
const BLOCKED = 'blocked -> running needs its reporting session or lead Agent.';

// The synthetic Provider keeps the task's status and revision. A report on a
// blocked task is refused as the real one refuses it: its own reason first
// (refuseReport), then task_blocked_elsewhere. reblockAt: the revision the task
// has moved to by the time the clear arrives (a block reported again).
function world({ organisation = true, refuseReport = null, refuseAfterClear = null, reblockAt = null } = {}) {
  const delegation = createAgentDelegation(null);
  if (!organisation) delegation.setCategory('organisation', false);
  const task = { status: 'blocked', revision: 3 };
  const provider = [];
  const port = taskBlockerConsole('synthetic-data-dir', { send: async (path, body) => {
    provider.push({ path, body });
    if (reblockAt != null) task.revision = reblockAt;
    if (body.expected_revision != null && body.expected_revision !== task.revision) {
      return { ok: false, status: 409, payload: { detail: `task revision is stale: expected ${body.expected_revision}, `
        + `current ${task.revision}; nothing was cleared, read the task again` } };
    }
    Object.assign(task, { status: body.resume_status ?? 'running', revision: task.revision + 1 });
    return { ok: true, status: 200, payload: { task_id: 'task-a', personal_space_id: 'personal-space',
      personal_project_id: 'project-a', title: 'Synthetic', status: task.status, revision: task.revision,
      participants: [], events: [] } };
  } });
  const app = {
    config: { personal: { spaceId: 'personal-space' } },
    taskContextRegistry: { context: async () => ({ projectAgentId: 'fla-b', personalProjectId: 'project-a',
      sourceApplication: 'claude_code', sessionId: 'session-b' }) },
    activity: [],
    async recordProjectAgentTaskActivity(input) {
      this.activity.push(input);
      if (refuseReport) throw new ProviderRequestError(refuseReport, { status: 409 });
      if (task.status === 'blocked') throw new ProviderRequestError(BLOCKED, { status: 409, code: 'task_blocked_elsewhere' });
      if (refuseAfterClear) throw new ProviderRequestError(refuseAfterClear, { status: 409 });
      task.revision += 1;
      return { taskId: 'task-a', status: input.status, revision: task.revision };
    },
    async viewProjectAgentTask() { return { taskId: 'task-a', status: task.status, revision: task.revision }; }
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
      try {
        await handleDelegatedRequest({ request, response, delegation, agentAccessEnabled: () => true,
          handle: () => handleTaskBlockerRequest({ request, response, url: new URL(url), app, blockerConsole: port }) });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: error.status ?? 500,
          headers: sent.headers });
      }
      return new Response(sent.body, { status: response.statusCode, headers: sent.headers });
    } });
  return { app, delegation, provider, task };
}

const report = (changes = {}) => ({ personalSpaceId: 'personal-space', personalProjectId: 'project-a', taskId: 'task-a',
  idempotencyKey: 'resume-1', status: 'running', summary: 'Rotated the expired credential; continuing.',
  agentId: 'fla-b', taskContextToken: 'fuli-task-synthetic', ...changes });
const record = (app, input) => callAgentTool(app, 'record_project_agent_task_activity', input);

test('a blocked task resumes in one call under the person\'s AI permission, recorded with the Agent and its reason', async () => {
  const { app, delegation, provider } = world();
  const result = await record(app, report({ expectedRevision: 3 }));
  assert.equal(result.status, 'running');
  assert.deepEqual(result.blockerCleared.by, { agentId: 'fla-b', client: 'claude_code', sessionId: 'session-b' });
  assert.equal(result.blockerCleared.permission, 'Settings › AI permissions › Organisation');
  assert.match(result.blockerCleared.receipt.markdown, /AI 权限 · organisation/);
  // The clear names the FLA, its reason and the revision the refusal was for; the report follows on the cleared one.
  assert.deepEqual(provider, [{ path: '/v1/project-agent-tasks/task-a/blocker/clear', body: {
    personal_space_id: 'personal-space', personal_project_id: 'project-a',
    note: 'Rotated the expired credential; continuing.', cleared_by: 'agent', agent_id: 'fla-b',
    source_application: 'claude_code', source_session_id: 'session-b', resume_status: 'running',
    expected_revision: 3 } }]);
  assert.equal(app.activity.length, 2);
  assert.equal(app.activity[1].expectedRevision, 4);
  const [operation] = delegation.read().operations;
  assert.equal(operation.route, 'POST /api/project-agent-tasks/:taskId/blocker/clear');
  assert.equal(operation.actor.agentId, 'fla-b');
  assert.equal(result.blockerCleared.operationId, operation.id);
});

test('a report asking for queued puts the cleared task back in its queue, guarded by the revision it read', async () => {
  const { app, provider } = world();
  const result = await record(app, report({ status: 'queued' }));
  assert.deepEqual([provider[0].body.resume_status, provider[0].body.expected_revision], ['queued', 3]);
  assert.equal(result.blockerCleared.resumedAs, 'queued');
  assert.equal(app.activity[1].expectedRevision, undefined);
});

test('with the Organisation permission off nothing is cleared and the refusal names the switch', async () => {
  const { app, delegation, provider } = world({ organisation: false });
  await assert.rejects(record(app, report()), (error) => {
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

test('a report the Provider refuses for its own reason (not assigned, no lead, client, stale) clears nothing', async () => {
  for (const reason of ['Agent is not assigned to this task', 'task has no lead yet',
    'project Agent is not available to this source client', 'task revision is stale: expected 2, current 3']) {
    const { app, provider, task } = world({ refuseReport: reason });
    await assert.rejects(record(app, report()), (error) => error.message === reason);
    assert.deepEqual(provider, [], reason);
    assert.equal(task.status, 'blocked');
  }
});

test('a block reported again between the refusal and the clear is not cleared', async () => {
  const { app, provider, task } = world({ reblockAt: 4 });
  await assert.rejects(record(app, report({ expectedRevision: 3 })), (error) => {
    assert.match(error.message, /^The block was not cleared and the report was not recorded\. /);
    assert.match(error.message, /expected 3, current 4; nothing was cleared/);
    return true;
  });
  assert.equal(provider.length, 1);
  assert.deepEqual([task.status, task.revision], ['blocked', 4]);
});

test('a report refused after the clear says plainly that the block was cleared, by whom, and the report was not', async () => {
  const { app, delegation, task } = world({ refuseAfterClear: 'Agent is not assigned to this task' });
  await assert.rejects(record(app, report()), (error) => {
    const [operation] = delegation.read().operations;
    assert.equal(error.code, 'task_report_refused_after_clear');
    assert.equal(error.message, `The block WAS cleared (record ${operation.id}, by fla-b) and the task is running; `
      + 'this report was NOT recorded: Agent is not assigned to this task');
    return true;
  });
  assert.equal(task.status, 'running');
});

test('the Agent tool never writes the person\'s event, whatever the status', async () => {
  // rec#123 review: actorKind human is refused on the Agent channel; the Provider refuses it too
  // (graph-provider/tests/test_task_person_close.py), and the console's own close stays the person's.
  const app = { graphiti: true, close() {}, recordProjectAgentTaskActivity: async () => assert.fail('reached the Provider') };
  const mcp = createMcpServer(app, { env: {}, toolNames: ['record_project_agent_task_activity'], registerResources: false });
  const client = new Client({ name: 'person-event-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(b); await client.connect(a);
    for (const status of ['cancelled', 'completed', 'running']) {
      const called = await client.callTool({ name: 'record_project_agent_task_activity',
        arguments: { ...report({ status, taskContextToken: undefined }), actorKind: 'human' } });
      assert.equal(called.isError, true, status);
      assert.match(called.content[0].text, /actorKind/, status);
    }
  } finally {
    await client.close(); await mcp.close();
  }
});

test('no clear without the calling task or for a status the clear does not resume', async () => {
  const tokenless = world();
  await assert.rejects(record(tokenless.app, report({ taskContextToken: undefined })), /Resend with your taskContextToken/);
  const completing = world();
  await assert.rejects(record(completing.app, report({ status: 'completed' })),
    (error) => error.code === 'task_blocked_elsewhere');
  for (const { provider } of [tokenless, completing]) assert.deepEqual(provider, []);
});
