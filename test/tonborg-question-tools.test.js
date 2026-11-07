import test from 'node:test';
import assert from 'node:assert/strict';

import { createJudgmentService } from '../src/judgment/service.js';
import { createQuestionTools } from '../src/judgment/question-tools.js';
import { TONBORG_QUESTION_DEFINITIONS } from '../src/agent-tools/tonborg-question-definitions.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';

// list_tonborg_questions / answer_tonborg_question (Jevons 11-07: the
// person's own AI goes through Tonborg's unsure items), on synthetic records
// only. Tonborg's reason and question never reach the Agent; answers run only
// on the person's words, at the item's version, and the vote goes through the
// real feedback check behind a fake console.

const list = (app, input) => app.judgment.agent.questions(input);
const answer = (app, input) => app.judgment.agent.answerQuestion(input);
const SECRET = 'PRIVATE-PREFERENCE-ALPHA';

function fixture(t, { visible = null, states = {}, version = 3, said = '不要了，这条过时了' } = {}) {
  const sent = [], revisions = [];
  const app = {
    config: { personal: { spaceId: 's' } },
    listPersonalProjects: async () => [{ project_id: 'p' }, { project_id: 'q' }],
    personal: {
      readVisibleKnowledgeItems: async ({ items, with_state: withState, with_version: withVersion }) => {
        const shown = items.filter(item => !visible || visible.includes(`${item.item_kind}:${item.item_id}`));
        return { items: shown, ...(withState ? { states: shown.map(item => ({ ...item,
          state: states[`${item.item_kind}:${item.item_id}`] ?? 'pending', ...(withVersion ? { version } : {}) })) } : {}) };
      }
    },
    taskContextRegistry: { context: () => ({ projectAgentId: 'fla-1', personalProjectId: 'p', sourceApplication: 'codex', sessionId: 'session-1' }) },
    entryPrompts: { read: () => ({ prompt: said, keptAt: '2026-11-07T00:00:00.000Z' }) },
    recentSessionUserMessages: async () => [],
    reviseKnowledgeItem: async input => { revisions.push(input); return { ok: true }; },
    // The console: feedback runs the real judgment check and store, as the delegation gate would.
    delegatedConsole: { send: async call => {
      sent.push(call);
      if (call.path === '/api/judgment/feedback') {
        const relay = { relayedBy: call.call.actor.agentId, personWords: call.call.relayed.words, messageRef: call.call.relayed.messageRef };
        return { result: await app.judgment.feedback(call.body, relay), operationId: `op-${sent.length}` };
      }
      return { result: { ok: true }, operationId: `op-${sent.length}` };
    } }
  };
  const service = createJudgmentService({ app, questionTools: createQuestionTools });
  app.judgment = service;
  t.after(() => service.close());
  let n = 0;
  const ask = (target, title, guess, { project = 'p' } = {}) => service.store().record('s', { personalProjectId: project,
    kind: 'review', target, title, summary: `${SECRET}: Tonborg reason for ${title}`, confidence: 0.6, outcome: 'escalate',
    delegated: true, guess, question: `${SECRET} I guess you ${guess} this. Right?` }, `ask:${target}:${n++}`);
  return { app, service, sent, revisions, ask };
}

const space = { personalSpaceId: 's' };
const changes = f => f.sent.length + f.revisions.length;

test('the list and one question give the item and guess, never Tonborg\'s reason or question', async t => {
  const f = fixture(t);
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  f.ask('relationship:pnpm', 'Use pnpm in this repo', 'keep', { project: null });
  const listed = await list(f.app, space);
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.questions.map(question => [question.item, question.guess]).sort(),
    [['Deploy on Fridays', 'drop'], ['Use pnpm in this repo', 'keep']]);
  const one = await list(f.app, { ...space, decisionId: unsure.id });
  assert.deepEqual(one.item, { itemKind: 'entity', itemId: 'fridays', text: 'Deploy on Fridays' });
  assert.equal(one.guess, 'drop');
  assert.match(one.next, /reason stays in the FULI console/);
  // Written from Tonborg's private context: withheld in both reads.
  assert.doesNotMatch(JSON.stringify([listed, one]), new RegExp(`${SECRET}|Right\\?|reason for`));
});

test('an FLA sees only its project\'s and global items it may see; a hidden one, even in the same batch, is only counted', async t => {
  const f = fixture(t, { visible: ['entity:mine', 'entity:global'] });
  f.ask('entity:mine', 'Mine', 'keep');
  f.ask('entity:global', 'Global', 'keep', { project: null });
  const hidden = f.ask('entity:hidden', 'Secret item title', 'drop');
  f.ask('entity:other', 'Other project item', 'keep', { project: 'q' });
  const listed = await list(f.app, { ...space, personalProjectId: 'p', projectAgentId: 'fla-1' });
  assert.deepEqual(listed.questions.map(question => question.item).sort(), ['Global', 'Mine']);
  assert.equal(listed.hiddenCount, 1);
  assert.doesNotMatch(JSON.stringify(listed), /Secret|Other project/);
  await assert.rejects(list(f.app, { ...space, decisionId: hidden.id }), /not an open Tonborg question/);
  await assert.rejects(answer(f.app, { ...space, decisionId: hidden.id, answer: 'keep', personWords: '不要了，这条过时了',
    taskContextToken: 'task-token' }), /not an open Tonborg question/);
  assert.equal(changes(f), 0);
});

test('an item decided elsewhere and an older question about the same item are not open', async t => {
  const f = fixture(t, { states: { 'entity:done': 'confirmed' } });
  f.ask('entity:done', 'Done', 'keep');
  const older = f.ask('entity:open', 'Open', 'drop');
  const newer = f.ask('entity:open', 'Open', 'keep');
  const listed = await list(f.app, space);
  assert.deepEqual(listed.questions.map(question => question.decisionId), [newer.id]);
  await assert.rejects(answer(f.app, { ...space, decisionId: older.id, answer: 'drop', personWords: '不要了，这条过时了',
    taskContextToken: 'task-token' }), /not an open Tonborg question/);
  assert.equal(changes(f), 0);
});

test('an answered question is no longer listed, and a long list says how many more there are', async t => {
  const f = fixture(t);
  const first = f.ask('entity:a', 'A', 'keep');
  f.ask('entity:b', 'B', 'keep');
  f.ask('entity:c', 'C', 'keep');
  await f.service.feedback({ ...space, decisionId: first.id, vote: 'up', reason: '', expectedRevision: 0 });
  const listed = await list(f.app, { ...space, limit: 1 });
  assert.deepEqual([listed.total, listed.questions.length, listed.more], [2, 1, 1]);
});

test('keep confirms the item as the person\'s, then the real feedback check records the vote on the guess', async t => {
  const f = fixture(t, { said: '保留，这条还对' });
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  const result = await answer(f.app, { ...space, decisionId: unsure.id, answer: 'keep', personWords: '保留',
    taskContextToken: 'task-token', sourceApplication: 'codex', sourceSessionId: 'session-1' });
  assert.deepEqual(f.sent.map(call => call.path), ['/api/knowledge/batch-confirmation', '/api/judgment/feedback']);
  const [confirm] = f.sent;
  assert.deepEqual(confirm.body.items.map(item => [item.itemKind, item.itemId]), [['entity', 'fridays']]);
  assert.doesNotMatch(JSON.stringify(confirm.body), new RegExp(SECRET));
  assert.equal(result.vote, 'down');
  const stored = f.service.store().get('s', unsure.id).feedback;
  assert.deepEqual({ vote: stored.vote, words: stored.personWords }, { vote: 'down', words: '保留' });
});

test('words that pick one of the question\'s options are voted as that option and must mean the same answer', async t => {
  const f = fixture(t, { said: '保持当前记录' });
  const asked = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  // 保持当前记录 is the keep option: answering drop with it is refused before anything changes.
  await assert.rejects(answer(f.app, { ...space, decisionId: asked.id, answer: 'drop', personWords: '保持当前记录',
    taskContextToken: 'task-token' }), /is the answer keep, not drop/);
  assert.equal(changes(f), 0);
  // As keep it votes up (the option's rule) although Tonborg guessed drop, and the real check accepts it.
  const result = await answer(f.app, { ...space, decisionId: asked.id, answer: 'keep', personWords: '保持当前记录',
    taskContextToken: 'task-token' });
  assert.equal(result.vote, 'up');
  assert.equal(f.service.store().get('s', asked.id).feedback.vote, 'up');
});

test('drop and edit change the item themselves at the version read now, then vote', async t => {
  const f = fixture(t, { version: 7 });
  const dropped = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  const result = await answer(f.app, { ...space, decisionId: dropped.id, answer: 'drop', personWords: '不要了',
    taskContextToken: 'task-token' });
  assert.deepEqual(f.revisions.map(({ itemKind, itemId, action, expectedVersion, operationActor }) =>
    ({ itemKind, itemId, action, expectedVersion, operationActor })),
  [{ itemKind: 'entity', itemId: 'fridays', action: 'invalidate', expectedVersion: 7, operationActor: 'agent' }]);
  assert.match(f.revisions[0].reason, /不要了/);
  assert.deepEqual([result.vote, f.service.store().get('s', dropped.id).feedback.vote], ['up', 'up']);

  const g = fixture(t, { version: 2, said: '改成：只在周一到周四部署' });
  const edited = g.ask('relationship:deploy', 'Deploy on Fridays', 'keep');
  await assert.rejects(answer(g.app, { ...space, decisionId: edited.id, answer: 'edit', personWords: '只在周一到周四部署',
    taskContextToken: 'task-token' }), /newText is required/);
  await answer(g.app, { ...space, decisionId: edited.id, answer: 'edit', personWords: '只在周一到周四部署',
    newText: '只在周一到周四部署', taskContextToken: 'task-token' });
  assert.deepEqual(g.revisions.map(({ action, fact, expectedVersion }) => ({ action, fact, expectedVersion })),
    [{ action: 'update', fact: '只在周一到周四部署', expectedVersion: 2 }]);
  assert.equal(g.service.store().get('s', edited.id).feedback.vote, 'down');
});

test('words the person did not say change nothing', async t => {
  const f = fixture(t, { said: '先别动，等我看完' });
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  for (const choice of ['keep', 'drop']) {
    await assert.rejects(answer(f.app, { ...space, decisionId: unsure.id, answer: choice, personWords: '不要了',
      taskContextToken: 'task-token' }), error => error.code === 'person_words_not_found');
  }
  assert.equal(changes(f), 0);
});

test('the tools are listed with their schemas and in the interface catalog', () => {
  assert.deepEqual(TONBORG_QUESTION_DEFINITIONS.map(tool => tool.name), ['list_tonborg_questions', 'answer_tonborg_question']);
  const answerSchema = TONBORG_QUESTION_DEFINITIONS[1].inputSchema;
  assert.deepEqual(answerSchema.required, ['personalSpaceId', 'decisionId', 'answer', 'personWords', 'taskContextToken']);
  assert.ok(answerSchema.properties.newText);
  const domain = agentInterfaceCatalog().readWorkflows.find(entry => entry.domain === 'tonborg-questions');
  assert.deepEqual(domain.toolNames, ['list_tonborg_questions', 'answer_tonborg_question']);
});
