import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { projectAgentTaskRecord } from '../src/graphiti/project-agent-mapping.js';

// rec#123: a synthetic space whose tasks carry long histories, as real ones do.
const LONG = 'Synthetic progress note with enough words to be long. '.repeat(20);

function providerTask(index, { events = 43, status = 'blocked' } = {}) {
  const at = new Date(Date.UTC(2026, 10, 1, 0, Math.floor(index / 2))).toISOString();
  return projectAgentTaskRecord({
    task_id: `task-${String(index).padStart(3, '0')}`, personal_space_id: 'space-a', personal_project_id: 'project-a',
    title: `Synthetic task ${index}`, objective: LONG, work_kind: 'implementation', status, revision: 162,
    routing_decision: { decision_id: `decision-${index}`, task_id: `task-${index}`, coordinator_agent_id: 'jefa',
      complexity: 'standard', complexity_basis: [LONG], outcome: 'assigned_existing', reason: 'exact_work_kind',
      match_basis: [LONG, LONG], created_at: at },
    lead_agent_id: 'agent-a', coordinator_agent_id: 'jefa',
    participants: [{ agent_id: 'agent-a', role: 'lead', status, assignment_summary: LONG, joined_at: at, updated_at: at }],
    blocker: status === 'blocked' ? { reason: LONG, since: at, agent_id: 'agent-a', source_application: 'codex' } : null,
    result_summary: LONG, failure_reason: null, quality_gate: null, created_at: at, updated_at: at, completed_at: null,
    events: Array.from({ length: events }, (_, event) => ({ event_id: `event-${index}-${event}`, task_id: `task-${index}`,
      agent_id: 'agent-a', status, actor_kind: 'agent', summary: LONG, created_at: at }))
  });
}

// The Provider's order and keyset: latest change first, then task ID.
function syntheticApp(tasks) {
  const calls = [];
  const sorted = [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
    || left.taskId.localeCompare(right.taskId));
  return { calls, graphiti: true, close() {}, async listProjectAgentTasks(input) {
    calls.push(input);
    const after = input.afterTaskId ? sorted.findIndex(task => task.taskId === input.afterTaskId) + 1 : 0;
    return sorted.slice(after, after + input.limit);
  } };
}

async function withTool(app, run) {
  const mcp = createMcpServer(app, { env: {}, toolNames: ['list_project_agent_tasks'], registerResources: false });
  const client = new Client({ name: 'task-summary-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(b); await client.connect(a);
    return await run(input => client.callTool({ name: 'list_project_agent_tasks',
      arguments: { personalSpaceId: 'space-a', ...input } }));
  } finally {
    await client.close(); await mcp.close();
  }
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('the list gives summaries without events or routing, bounded text and every triage field', async () => {
  const app = syntheticApp(Array.from({ length: 14 }, (_, index) => providerTask(index)));
  await withTool(app, async list => {
    const { structuredContent: page, isError } = await list({ status: 'blocked' });
    assert.equal(isError, undefined);
    assert.equal(page.truncated, undefined);
    assert.equal(page.tasks.length, 14);
    assert.equal(page.nextCursor, null);
    assert.match(page.detail, /view_project_agent_task/);
    for (const task of page.tasks) {
      for (const field of ['events', 'routingDecision', 'objective', 'matchBasis']) assert.equal(field in task, false, field);
      for (const field of ['taskId', 'title', 'status', 'personalProjectId', 'leadAgentId', 'createdAt', 'updatedAt']) {
        assert.ok(task[field], field);
      }
      assert.deepEqual(task.participants, [{ agentId: 'agent-a', role: 'lead', status: 'blocked' }]);
      assert.ok(Buffer.byteLength(task.resultSummary) <= 400 && task.resultSummary.endsWith('…'));
      assert.ok(Buffer.byteLength(task.blocker.reason) <= 400);
      assert.equal(task.blocker.since, task.updatedAt);
    }
    assert.equal(app.calls[0].status, 'blocked');
    assert.equal(app.calls[0].limit, 51);
    // 14 long-history tasks were about 700 KB in full and cut at 128 KB; as summaries about 20 KB.
    assert.ok(bytes(page) < 24 * 1024, `${bytes(page)} B`);
  });
});

test('a page that reaches its byte bound stops whole and the cursor lists every other task once', async () => {
  const tasks = Array.from({ length: 150 }, (_, index) => providerTask(index, { events: 0 }));
  for (const task of tasks) Object.assign(task, { title: LONG, failureReason: LONG });
  const app = syntheticApp(tasks);
  await withTool(app, async list => {
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const { structuredContent: page } = await list({ limit: 100, ...(cursor ? { cursor } : {}) });
      assert.equal(page.truncated, undefined);
      assert.ok(bytes(page) < 128 * 1024);
      assert.ok(page.tasks.every(task => task.taskId && task.updatedAt), 'no empty or partial entries');
      seen.push(...page.tasks.map(task => task.taskId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.ok(pages >= 3, `${pages} pages`);
    assert.equal(seen.length, 150);
    assert.equal(new Set(seen).size, 150);
    const [, second] = app.calls;
    assert.ok(second.afterTaskId && second.afterUpdatedAt);
  });
});

test('a cursor the list did not give is refused with what to pass', async () => {
  await withTool(syntheticApp([providerTask(1)]), async list => {
    for (const cursor of ['not-a-cursor', Buffer.from('null').toString('base64url'),
      Buffer.from('["yesterday","task-1"]').toString('base64url')]) {
      const result = await list({ cursor });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'invalid_input');
      assert.match(result.structuredContent.error.message, /nextCursor of an earlier list_project_agent_tasks page/);
    }
  });
});
