import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { RecallImpressionsStore } from '../src/knowledge-impressions/store.js';
import { beginTaskFromPreferences, checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';

// rec#63 direction A, step 1: recording which recalled items the Agent was
// shown and which it reported using. Synthetic spaces, projects, Agents and
// items only; no real FULI data directory or transcript is read.

function storeIn(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-recall-impressions-'));
  const path = join(directory, 'recall-impressions.sqlite');
  const store = new RecallImpressionsStore(path, options.now);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, directory };
}

const SHOWN = {
  taskContextToken: 'fuli-task-synthetic-shown',
  personalSpaceId: 'space-a',
  personalProjectId: 'project-a',
  facts: [
    { id: 'rel-1', score: 0.9, confirmation_status: 'confirmed' },
    { id: 'rel-2', score: 0.4, confirmation_status: 'pending' }
  ],
  entities: [
    { id: 'ent-1', score: 0.8, confirmation_status: 'confirmed' },
    { id: 'ent-2', score: null, confirmation_status: null }
  ]
};

test('recordShown stores ids, rank, score and confirmation status; a second call does not duplicate rows', (t) => {
  const { store } = storeIn(t);
  store.recordShown(SHOWN);
  store.recordShown(SHOWN);
  assert.deepEqual(store.summary({ personalSpaceId: 'space-a', personalProjectId: 'project-a' }),
    { tasks: 1, shown: 4, used: 0, byRank: [{ rank: 1, shown: 2, used: 0 }, { rank: 2, shown: 2, used: 0 }] });
});

test('markUsed updates only rows that were shown; a used-but-never-shown item is ignored', (t) => {
  const { store } = storeIn(t);
  store.recordShown(SHOWN);
  store.markUsed({ taskContextToken: SHOWN.taskContextToken, items: [
    { itemId: 'rel-1', itemKind: 'relationship', useKind: 'applied' },
    { itemId: 'missing', itemKind: 'entity', useKind: 'cited' }
  ] });
  assert.deepEqual(store.summary({ personalSpaceId: 'space-a', personalProjectId: 'project-a' }),
    { tasks: 1, shown: 4, used: 1, byRank: [{ rank: 1, shown: 2, used: 1 }, { rank: 2, shown: 2, used: 0 }] });
});

test('summary groups shown and used by rank and separates projects', (t) => {
  const { store } = storeIn(t);
  store.recordShown({ ...SHOWN, taskContextToken: 'fuli-task-a' });
  store.recordShown({ ...SHOWN, taskContextToken: 'fuli-task-b', personalProjectId: 'project-b' });
  store.markUsed({ taskContextToken: 'fuli-task-a', items: [
    { itemId: 'rel-1', itemKind: 'relationship', useKind: 'applied' }] });
  assert.deepEqual(store.summary({ personalSpaceId: 'space-a', personalProjectId: 'project-a' }),
    { tasks: 1, shown: 4, used: 1, byRank: [{ rank: 1, shown: 2, used: 1 }, { rank: 2, shown: 2, used: 0 }] });
  assert.deepEqual(store.summary({ personalSpaceId: 'space-a', personalProjectId: 'project-b' }),
    { tasks: 1, shown: 4, used: 0, byRank: [{ rank: 1, shown: 2, used: 0 }, { rank: 2, shown: 2, used: 0 }] });
  assert.deepEqual(store.summary({ personalSpaceId: 'space-a' }),
    { tasks: 2, shown: 8, used: 1, byRank: [{ rank: 1, shown: 4, used: 1 }, { rank: 2, shown: 4, used: 0 }] });
});

test('rows older than 180 days are deleted on the next write', (t) => {
  let current = new Date('2026-01-01T00:00:00Z');
  const { store } = storeIn(t, { now: () => current });
  store.recordShown(SHOWN);
  current = new Date('2026-07-20T00:00:00Z');
  store.recordShown({ ...SHOWN, taskContextToken: 'fuli-task-later' });
  assert.deepEqual(store.summary({ personalSpaceId: 'space-a', personalProjectId: 'project-a' }),
    { tasks: 1, shown: 4, used: 0, byRank: [{ rank: 1, shown: 2, used: 0 }, { rank: 2, shown: 2, used: 0 }] });
});

test('the task context token is never stored, only its SHA-256 hex', (t) => {
  const { store, path } = storeIn(t);
  store.recordShown(SHOWN);
  store.close();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const keys = database.prepare('SELECT task_key FROM recall_impressions').all().map((row) => row.task_key);
    assert.equal(keys.length, 4);
    for (const key of keys) {
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.notEqual(key, SHOWN.taskContextToken);
    }
  } finally { database.close(); }
  assert.equal(readFileSync(path).includes(Buffer.from(SHOWN.taskContextToken)), false);
});

test('a missing store reads as empty and is never created by a read', (t) => {
  const { store, path } = storeIn(t);
  assert.deepEqual(store.summary({ personalSpaceId: 'space-a' }),
    { tasks: 0, shown: 0, used: 0, byRank: [] });
  assert.equal(existsSync(path), false);
});

const entryPreferences = () => ({
  context: { personal_space_id: 'space-a', personal_project_id: 'project-a', project_agent_id: null },
  task_knowledge_recall: {
    status: 'matched',
    facts: [{ id: 'rel-1', score: 0.9, confirmation_status: 'confirmed' }],
    entities: [{ id: 'ent-1', score: 0.8, confirmation_status: 'pending' }]
  }
});

function entryApp(recallImpressions) {
  let index = 0;
  return { config: { personal: { spaceId: 'space-a' } },
    taskContextRegistry: { begin: async () => ({ token: `fuli-task-entry-${++index}`, sessionId: 'session-a',
      personalProjectId: 'project-a', projectAgentId: null, sourceApplication: 'codex', entryVia: 'tool',
      checkpoint: null }) },
    recallImpressions };
}

test('task entry records the shown recall items, and a resumed entry does not', async () => {
  const store = new RecallImpressionsStore(':memory:');
  await beginTaskFromPreferences(entryApp(store), entryPreferences(), { sessionId: 'session-a', sourceApplication: 'codex' });
  assert.equal(store.summary({ personalSpaceId: 'space-a', personalProjectId: 'project-a' }).shown, 2);
  await beginTaskFromPreferences(entryApp(store), entryPreferences(), { sessionId: 'session-a', sourceApplication: 'codex' },
    { resumed: true });
  assert.equal(store.summary({ personalSpaceId: 'space-a', personalProjectId: 'project-a' }).shown, 2);
});

test('a throwing store never breaks task entry', async () => {
  const app = entryApp({ recordShown: () => { throw new Error('synthetic record failure'); } });
  const result = await beginTaskFromPreferences(app, entryPreferences(), { sessionId: 'session-a', sourceApplication: 'codex' });
  assert.equal(result.taskContextToken, 'fuli-task-entry-1');
});

function checkpointApp(recallImpressions) {
  let task = { token: 'fuli-task-checkpoint-synthetic', personalProjectId: 'project-a', projectAgentId: 'owner',
    sessionId: 'parent', sourceApplication: 'codex', workLogRequired: true, checkpoint: null };
  return { config: { personal: { spaceId: 'space-a' } },
    listProjectAgents() { throw new Error('An active directory entry is not participation evidence'); },
    recallImpressions,
    taskContextRegistry: { context: async () => structuredClone(task), prepare: async () => task,
      checkpoint: async (_token, claim) => {
        task = { ...task, checkpoint: { ...claim, phase: 'complete' } };
        return structuredClone(task);
      } } };
}

const checkpointInput = () => ({ taskContextToken: 'fuli-task-checkpoint-synthetic', sourceApplication: 'codex',
  disposition: 'retain_nothing', reason: 'Synthetic.',
  workLog: { status: 'completed', summary: 'Done.' },
  knowledgeUsage: [{ itemId: 'entity-1', itemKind: 'entity', useKind: 'applied' },
    { itemId: 'rel-1', itemKind: 'relationship', useKind: 'cited' }] });

test('checkpoint marks the accepted knowledgeUsage items as used', async () => {
  const marks = [];
  const app = checkpointApp({ markUsed: (input) => marks.push(input) });
  await checkpointTaskKnowledge(app, checkpointInput());
  assert.deepEqual(marks, [{ taskContextToken: 'fuli-task-checkpoint-synthetic', items: checkpointInput().knowledgeUsage }]);
});

test('a throwing store never breaks the checkpoint', async () => {
  const app = checkpointApp({ markUsed: () => { throw new Error('synthetic mark failure'); } });
  const result = await checkpointTaskKnowledge(app, checkpointInput());
  assert.equal(result.status, 'checkpointed');
});
