import assert from 'node:assert/strict';
import test from 'node:test';

import { beginTaskContext, beginTaskFromPreferences } from '../src/graphiti/agent-knowledge-workflows.js';
import { setSessionCapturePause } from '../src/graphiti/session-capture-pause-request.js';
import { RecallImpressionsStore, taskKeyFor } from '../src/knowledge-impressions/store.js';
import { handleKnowledgeItemRequest } from '../src/http/knowledge-item-api-router.js';

// The first reply of a new conversation says how many of the person's habits
// FULI handed over (docs/session-preference-delivery.md). Synthetic spaces,
// sessions, Agents and preferences; the Provider is a fake that binds each
// native session to the conversation its first task opened.

const CONSOLE = 'http://127.0.0.1:3999';
const IDENTITY = 'FULI Agent：负责人 X';
const HABITS = [{ id: 'pref-1', item_kind: 'entity', instruction: 'Synthetic rule one' },
  { id: 'pref-2', item_kind: 'entity', instruction: 'Synthetic rule two' },
  { id: 'rel-1', item_kind: 'relationship', instruction: 'Synthetic rule three' }];
const habitsLine = (token, count) => `FULI 习惯：这个新对话带上了你的 ${count} 条习惯 · `
  + `[看看是哪几条](${CONSOLE}/habits/${taskKeyFor(token).slice(0, 16)})`;

function application({ captureEnabled = true, store = new RecallImpressionsStore(':memory:'), conversation = null,
  projectAgentId = 'lead' } = {}) {
  let index = 0;
  const bound = new Map();
  const tasks = new Map();
  return { consoleUrl: CONSOLE, config: { personal: { spaceId: 'synthetic-space' } }, recallImpressions: store,
    getCapturePolicy: () => ({ enabled: captureEnabled }),
    taskContextRegistry: {
      begin: async ({ sessionId, sourceApplication, entryVia }) => {
        const task = { token: `fuli-task-second-day-${++index}`, sessionId, personalProjectId: 'project-a', projectAgentId,
          sourceApplication, entryVia, checkpoint: null };
        tasks.set(task.token, task);
        return task;
      },
      context: async token => tasks.get(token)
    },
    personal: {
      conversation: conversation ?? (async (operation, input) => {
        const previous = bound.get(input.session_id) ?? null;
        bound.set(input.session_id, previous ?? `conversation-${input.session_id}`);
        return { status: 'saved', conversation_id: bound.get(input.session_id), revision: 1, recovered_from: previous,
          previous: previous ? { compacted_through: 0, context: { messages: [] } } : null, recent: null };
      }),
      getProjectAgent: async () => ({ profile: { display_name: 'X', name: '负责人' } })
    } };
}

const preferences = (effective = HABITS, projectAgentId = 'lead') => ({
  context: { personal_space_id: 'synthetic-space', personal_project_id: 'project-a', project_agent_id: projectAgentId },
  effective_preferences: effective, agent_receipt: { required: true, markdown: IDENTITY } });

const viaTool = (app, sessionId, value = preferences(), options = {}) =>
  beginTaskFromPreferences(app, value, { sessionId, sourceApplication: 'codex' }, options);

test('a new conversation with 3 habits ends its receipt with the line and the link', async () => {
  const app = application();
  const entry = await viaTool(app, 'session-new');
  assert.equal(entry.agent_receipt.markdown, `${IDENTITY}\n${habitsLine(entry.taskContextToken, 3)}`);
  assert.equal(entry.agent_receipt.markdown.split('\n').at(-1),
    `FULI 习惯：这个新对话带上了你的 3 条习惯 · [看看是哪几条](${CONSOLE}/habits/${taskKeyFor('fuli-task-second-day-1').slice(0, 16)})`);
});

test('the same session\'s second task, 0 habits, a resumed task and no assigned Agent show no line', async () => {
  const app = application();
  await viaTool(app, 'session-a');
  assert.equal((await viaTool(app, 'session-a')).agent_receipt.markdown, IDENTITY, 'the conversation was recovered');
  assert.equal((await viaTool(app, 'session-empty', preferences([]))).agent_receipt.markdown, IDENTITY);
  const resumedTask = { token: 'fuli-task-resumed', sessionId: 'session-resumed', personalProjectId: 'project-a',
    projectAgentId: 'lead', sourceApplication: 'codex', checkpoint: null };
  assert.equal((await viaTool(app, 'session-resumed', preferences(), { existingTask: resumedTask, resumed: true }))
    .agent_receipt.markdown, IDENTITY);
  const unassigned = application({ projectAgentId: null });
  assert.equal((await viaTool(unassigned, 'session-unassigned', preferences(HABITS, null))).agent_receipt.markdown, IDENTITY);
});

test('capture off, an unsaved conversation and a failing store show no line', async () => {
  assert.equal((await viaTool(application({ captureEnabled: false }), 'session-off')).agent_receipt.markdown, IDENTITY);
  const unsaved = application({ conversation: async () => { throw new Error('synthetic Provider failure'); } });
  assert.equal((await viaTool(unsaved, 'session-unsaved')).agent_receipt.markdown, IDENTITY);
  const failing = application({ store: { recordDelivered: () => { throw new Error('synthetic store failure'); } } });
  const entry = await viaTool(failing, 'session-failing');
  assert.equal(entry.agent_receipt.markdown, IDENTITY);
  assert.equal(entry.taskContextToken, 'fuli-task-second-day-1', 'the entry itself goes on');
});

test('the hook path and the tool path give the same line', async () => {
  const app = application();
  const hook = await beginTaskContext({ ...app, getCollaborationPreferences: async () => preferences() },
    { sessionId: 'session-hook', projectPath: '/synthetic/project', taskPrompt: 'Synthetic prompt', sourceApplication: 'codex' });
  const tool = await viaTool(app, 'session-tool');
  assert.equal(hook.agent_receipt.markdown, `${IDENTITY}\n${habitsLine(hook.taskContextToken, 3)}`);
  assert.equal(tool.agent_receipt.markdown, `${IDENTITY}\n${habitsLine(tool.taskContextToken, 3)}`);
});

test('a pause receipt of the first task keeps the line; a later task\'s never gains it', async () => {
  const app = application();
  app.setSessionCapturePause = (sessionId, { paused }) => ({ paused, since: '2026-11-15T00:00:00Z' });
  const first = await viaTool(app, 'session-pause');
  const later = await viaTool(app, 'session-pause');
  const pause = token => setSessionCapturePause(app, { taskContextToken: token, sessionPaused: true, sourceApplication: 'codex' });
  assert.equal((await pause(first.taskContextToken)).agent_receipt.markdown.split('\n').at(-1),
    habitsLine(first.taskContextToken, 3));
  assert.doesNotMatch((await pause(later.taskContextToken)).agent_receipt.markdown, /FULI 习惯/);
});

async function habitRequest(app, path, ownerReads = {}) {
  let status = 0, text = '';
  const response = { setHeader() {}, writeHead(value) { status = value; }, end(value) { text = value; } };
  const handled = await handleKnowledgeItemRequest({ request: { method: 'GET' }, response, url: new URL(path, 'http://127.0.0.1'),
    app, ownerReads });
  return { handled, status, body: text ? JSON.parse(text) : null };
}

test('the console reads one delivery record by its link key, owner reads only; a missing one is 404', async () => {
  const store = new RecallImpressionsStore(':memory:', () => new Date('2026-11-15T01:00:00Z'));
  const app = application({ store });
  const entry = await viaTool(app, 'session-route');
  const key = taskKeyFor(entry.taskContextToken).slice(0, 16);
  assert.deepEqual(await habitRequest(app, `/api/habit-deliveries/${key}`), { handled: true, status: 200, body: {
    at: '2026-11-15T01:00:00.000Z', client: 'codex', model: null,
    items: [{ kind: 'entity', id: 'pref-1' }, { kind: 'entity', id: 'pref-2' }, { kind: 'relationship', id: 'rel-1' }] } });
  assert.equal((await habitRequest(app, '/api/habit-deliveries/ffffffffffffffff')).status, 404);
  assert.equal((await habitRequest(app, '/api/habit-deliveries/not-a-key')).status, 404);
  assert.equal((await habitRequest(app, `/api/habit-deliveries/${key}`, null)).status, 503);
});
