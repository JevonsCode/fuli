// 「之前误存的 Agent 回复」: the console reads the group, the person drops it or
// takes the drop back, and an FLA lists it but only relays the drop.
// Synthetic graph pages only; nothing reads or changes real data.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { DELEGATION_HEADER, encodeDelegation } from '../src/agent-delegation/delegation-header.js';
import { callAgentTool } from '../src/agent-tools.js';
import { interfaceForRoute } from '../src/agent-tools/interface-catalog.js';
import { DROP_REASON, RESTORE_REASON, findReplyEchoes } from '../src/graphiti/reply-echo-group.js';
import { handleReplyEchoRequest } from '../src/http/reply-echo-api-router.js';

const SPACE = 'space-synthetic';
const echo = (id, sentence = `I moved the notice ${id}; the fix is in PR #842, not merged yet.`) => ({ id, type: 'ReusableExperience',
  name: sentence, summary: sentence, attributes: { solution: sentence }, confirmation_status: 'pending',
  confirmation_basis: { proposed_by: { kind: 'agent' } }, evidence: [{ source_kind: 'task_experience' }] });
const fact = id => ({ id, type: 'ProjectFact', name: 'Staging port', summary: 'The staging port is 4611.', confirmation_status: 'pending' });
// Two pages, as the Provider pages a large space.
const PAGES = [
  { nodes: [echo('e-1'), fact('f-1')], edges: [], truncated: true, next_offset: 2 },
  { nodes: [echo('e-2'), echo('e-1')], edges: [{ id: 'r-1', fact: 'I merged it. CI is green.', confirmation_status: 'pending' }], truncated: false }
];
const pages = (reads = []) => ({ graph: async ({ spaceId, limit, offset }) => {
  reads.push({ spaceId, limit, offset });
  return offset === 2 ? PAGES[1] : PAGES[0];
} });

function appStub() {
  const revisions = [];
  return { revisions, config: { personal: { spaceId: SPACE } },
    reviseKnowledgeItem: async (input) => {
      if (input.itemId === 'e-2' && input.action === 'restore') throw Object.assign(new Error('gone'), { code: 'not_found' });
      revisions.push(input);
      return {};
    } };
}

async function call({ method, path, body, headers = {}, app, ownerReads }) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method, url: path, headers, socket: { remoteAddress: '127.0.0.1' } });
  const response = { status: 0, headers: {}, text: '', setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.status = status; }, end(text) { this.text = text; } };
  const handled = await handleReplyEchoRequest({ request, response, url: new URL(path, 'http://127.0.0.1'), app, ownerReads });
  return { handled, status: response.status, body: response.text ? JSON.parse(response.text) : null };
}

test('every page is read and each echo counted once; real knowledge stays out', async () => {
  const reads = [];
  const found = await findReplyEchoes((limit, offset) => pages(reads).graph({ spaceId: SPACE, limit, offset }));
  assert.deepEqual(found.map(({ itemKind, itemId }) => `${itemKind}:${itemId}`), ['entity:e-1', 'entity:e-2', 'relationship:r-1']);
  assert.deepEqual(reads.map(read => read.offset), [null, 2]);
});

test('the console reads the group with its full read', async () => {
  const app = appStub();
  const listed = await call({ method: 'GET', path: `/api/knowledge/reply-echoes?personalSpaceId=${SPACE}`, app, ownerReads: pages() });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 3);
  assert.deepEqual(listed.body.items[0], { itemKind: 'entity', itemId: 'e-1', signals: ['reply_capture', 'progress_narration', 'status_report'] });
  assert.equal((await call({ method: 'GET', path: `/api/knowledge/reply-echoes?personalSpaceId=${SPACE}`, app })).status, 503);
  await assert.rejects(call({ method: 'GET', path: '/api/knowledge/reply-echoes?personalSpaceId=other', app, ownerReads: pages() }),
    /active personal space/);
  assert.equal((await call({ method: 'GET', path: '/api/knowledge/other', app, ownerReads: pages() })).handled, false);
});

test('dropping drops only items still found, as the person\'s existing drop', async () => {
  const app = appStub();
  const dropped = await call({ method: 'POST', path: '/api/knowledge/reply-echoes/drop', app, ownerReads: pages(),
    body: { personalSpaceId: SPACE, items: [{ itemKind: 'entity', itemId: 'e-1' }, { itemKind: 'entity', itemId: 'f-1' },
      { itemKind: 'relationship', itemId: 'r-1' }] } });
  assert.deepEqual(dropped.body, { dropped: [{ itemKind: 'entity', itemId: 'e-1' }, { itemKind: 'relationship', itemId: 'r-1' }],
    failed: [], skipped: [{ itemKind: 'entity', itemId: 'f-1' }] });
  assert.deepEqual(app.revisions.map(({ itemId, action, reason, operationActor, personalProjectId }) =>
    [itemId, action, reason, operationActor, personalProjectId]),
  [['e-1', 'invalidate', DROP_REASON, 'human', null], ['r-1', 'invalidate', DROP_REASON, 'human', null]]);
  await assert.rejects(call({ method: 'POST', path: '/api/knowledge/reply-echoes/drop', app, ownerReads: pages(),
    body: { personalSpaceId: SPACE, items: [] } }), /items takes 1 to 500/);
  await assert.rejects(call({ method: 'POST', path: '/api/knowledge/reply-echoes/drop', app, ownerReads: pages(),
    body: { personalSpaceId: SPACE, items: [{ itemKind: 'node', itemId: 'e-1' }] } }), /itemKind/);
});

test('an FLA\'s relay of the person\'s words is kept in the reason; 撤销 restores each', async () => {
  const app = appStub();
  const header = encodeDelegation({ actor: { agentId: 'lead-synthetic' }, reason: 'The person said so', bodyFields: ['items'],
    relayed: { words: '都丢掉吧', messageRef: {} } });
  await call({ method: 'POST', path: '/api/knowledge/reply-echoes/drop', app, ownerReads: pages(), headers: { [DELEGATION_HEADER]: header },
    body: { personalSpaceId: SPACE, items: [{ itemKind: 'entity', itemId: 'e-2' }] } });
  assert.equal(app.revisions[0].reason, `${DROP_REASON}（由 lead-synthetic 转达：「都丢掉吧」）`);
  const restored = await call({ method: 'POST', path: '/api/knowledge/reply-echoes/restore', app,
    body: { personalSpaceId: SPACE, items: [{ itemKind: 'entity', itemId: 'e-1' }, { itemKind: 'entity', itemId: 'e-2' }] } });
  assert.deepEqual(restored.body, { restored: [{ itemKind: 'entity', itemId: 'e-1' }], failed: [{ itemKind: 'entity', itemId: 'e-2', code: 'not_found' }] });
  assert.deepEqual(app.revisions.slice(1).map(({ action, reason }) => [action, reason]), [['restore', RESTORE_REASON]]);
});

test('an FLA lists the group it may see; the drop and its undo are the person\'s relayed decisions', async () => {
  const reads = [];
  const app = { config: { personal: { spaceId: SPACE } },
    taskContextRegistry: { context: async () => ({ personalProjectId: 'project-a', projectAgentId: 'fla-a' }) },
    personal: { graph: async (spaceId, limit, projectId, offset, reader) => {
      reads.push({ projectId, reader });
      return offset === 2 ? PAGES[1] : PAGES[0];
    } } };
  const listed = await callAgentTool(app, 'list_reply_echoes', { personalSpaceId: SPACE, taskContextToken: 'fuli-task-synthetic', limit: 2 });
  assert.equal(listed.total, 3);
  assert.equal(listed.more, 1);
  assert.deepEqual(listed.items.map(item => item.itemId), ['e-1', 'e-2']);
  assert.ok(listed.items[0].text.length <= 60);
  assert.match(listed.next, /POST \/api\/knowledge\/reply-echoes\/drop/);
  assert.match(listed.next, /personWords/);
  assert.deepEqual(reads[0], { projectId: 'project-a', reader: { personalProjectId: 'project-a', projectAgentId: 'fla-a' } });
  await assert.rejects(callAgentTool(app, 'list_reply_echoes', { personalSpaceId: 'other', taskContextToken: 'fuli-task-synthetic' }),
    /active personal space/);
  for (const route of ['POST /api/knowledge/reply-echoes/drop', 'POST /api/knowledge/reply-echoes/restore']) {
    assert.equal(interfaceForRoute(route)?.access, 'agent_relayed', route);
  }
});
