import test from 'node:test';
import assert from 'node:assert/strict';

import { createJudgmentService } from '../src/judgment/service.js';
import { createQuestionTools } from '../src/judgment/question-tools.js';
import { TONBORG_QUESTION_DEFINITIONS } from '../src/agent-tools/tonborg-question-definitions.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { delegatedReviewList } from '../src/judgment/review-delegation.js';

// list_tonborg_questions / answer_tonborg_question (Jevons 11-07: the
// person's own AI goes through Tonborg's unsure items), on synthetic records
// only. The reader is the calling task's; Tonborg's reason and question never
// reach the Agent; answers run only on the person's words, at the item's
// version, behind the delegation gate; the vote goes through the real
// feedback check behind a fake console.

const list = (app, input) => app.judgment.agent.questions(input);
const answer = (app, input) => app.judgment.agent.answerQuestion(input);
const SECRET = 'PRIVATE-PREFERENCE-ALPHA';
const PLAIN = { projectAgentId: null, personalProjectId: null, sourceApplication: 'codex', sessionId: 'session-1' };
const FLA = { projectAgentId: 'fla-1', personalProjectId: 'p', sourceApplication: 'codex', sessionId: 'session-1' };
// `#FLA Tonborg …` in a new chat with no project folder (task-entry-named-fla.js).
const TONBORG = { projectAgentId: 'employee.tonborg', personalProjectId: null, sourceApplication: 'codex', sessionId: 'session-1' };

// visible: the item keys each reader may see (key '' is a plain session); states, version: what the Provider says.
function fixture(t, { task = PLAIN, visible = {}, states = {}, version = 3, said = '不要了，这条过时了', capture = true,
  permission = true } = {}) {
  const sent = [], revisions = [];
  const app = {
    config: { personal: { spaceId: 's' } },
    getCapturePolicy: () => ({ enabled: capture }),
    listPersonalProjects: async () => [{ project_id: 'p' }, { project_id: 'q' }],
    personal: {
      readVisibleKnowledgeItems: async ({ items, with_state: withState, with_version: withVersion, reader_agent_id: agent = '' }) => {
        const allowed = visible[agent];
        const shown = items.filter(item => !allowed || allowed.includes(`${item.item_kind}:${item.item_id}`));
        return { items: shown, ...(withState ? { states: shown.map(item => ({ ...item,
          state: states[`${item.item_kind}:${item.item_id}`] ?? 'pending', ...(withVersion ? { version } : {}) })) } : {}) };
      }
    },
    taskContextRegistry: { context: () => task },
    entryPrompts: { read: () => ({ prompt: said, keptAt: '2026-11-07T00:00:00.000Z' }) },
    recentSessionUserMessages: async () => [],
    reviseKnowledgeItem: async input => { revisions.push(input); return { ok: true }; },
    // The console: its delegation gate, then feedback through the real judgment check and store.
    delegatedConsole: { send: async call => {
      if (!permission) throw Object.assign(new Error('This category was taken back by you'), { code: 'delegation_category_off' });
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

const call = { personalSpaceId: 's', taskContextToken: 'task-token' };
const changes = f => f.sent.length + f.revisions.length;
const listed = async (f, extra = {}) => (await list(f.app, { ...call, ...extra })).questions.map(question => question.item).sort();

test('the list and one question give the item, its version and the guess, never Tonborg\'s reason or question', async t => {
  const f = fixture(t, { version: 5 });
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  f.ask('relationship:pnpm', 'Use pnpm in this repo', 'keep', { project: null });
  const all = await list(f.app, call);
  assert.equal(all.total, 2);
  assert.deepEqual(all.questions.map(question => [question.item, question.guess]).sort(),
    [['Deploy on Fridays', 'drop'], ['Use pnpm in this repo', 'keep']]);
  const one = await list(f.app, { ...call, decisionId: unsure.id });
  assert.deepEqual(one.item, { itemKind: 'entity', itemId: 'fridays', text: 'Deploy on Fridays', version: 5 });
  assert.equal(one.guess, 'drop');
  assert.match(one.next, /reason stays in the FULI console/);
  // Written from Tonborg's private context: withheld in both reads.
  assert.doesNotMatch(JSON.stringify([all, one]), new RegExp(`${SECRET}|Right\\?|reason for`));
});

test('an FLA reads as its task\'s own FLA and project, whatever the arguments say, and learns nothing of what it may not see', async t => {
  const f = fixture(t, { task: FLA, visible: { 'fla-1': ['entity:mine', 'entity:global', 'entity:other'] } });
  f.ask('entity:mine', 'Mine', 'keep');
  f.ask('entity:global', 'Global', 'keep', { project: null });
  const hidden = f.ask('entity:hidden', 'Secret item title', 'drop');
  const other = f.ask('entity:other', 'Other project item', 'keep', { project: 'q' });
  // No projectAgentId argument, and another project named: still the task's FLA in project p.
  for (const extra of [{}, { personalProjectId: 'q' }]) {
    const read = await list(f.app, { ...call, ...extra });
    assert.deepEqual(read.questions.map(question => question.item).sort(), ['Global', 'Mine']);
    assert.equal(read.hiddenCount, undefined);
    assert.doesNotMatch(JSON.stringify(read), /Secret|Other project/);
  }
  for (const decision of [hidden, other]) {
    await assert.rejects(list(f.app, { ...call, decisionId: decision.id }), /not an open Tonborg question/);
    await assert.rejects(answer(f.app, { ...call, decisionId: decision.id, answer: 'keep', personWords: '不要了，这条过时了' }),
      /not an open Tonborg question/);
  }
  assert.equal(changes(f), 0);
  // A plain session may know that hidden items exist.
  const plain = fixture(t, { visible: { '': ['entity:mine'] } });
  plain.ask('entity:mine', 'Mine', 'keep');
  plain.ask('entity:hidden', 'Secret', 'drop');
  assert.equal((await list(plain.app, call)).hiddenCount, 1);
});

test('an item decided elsewhere and an older question about the same item are not open', async t => {
  const f = fixture(t, { states: { 'entity:done': 'confirmed' } });
  f.ask('entity:done', 'Done', 'keep');
  const older = f.ask('entity:open', 'Open', 'drop');
  const newer = f.ask('entity:open', 'Open', 'keep');
  assert.deepEqual((await list(f.app, call)).questions.map(question => question.decisionId), [newer.id]);
  await assert.rejects(answer(f.app, { ...call, decisionId: older.id, answer: 'drop', personWords: '不要了，这条过时了' }),
    /not an open Tonborg question/);
  assert.equal(changes(f), 0);
});

test('keep confirms the item as the person\'s, then the real feedback check records the vote on the guess', async t => {
  const f = fixture(t, { said: '保留，这条还对', version: 4 });
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  const result = await answer(f.app, { ...call, decisionId: unsure.id, answer: 'keep', personWords: '保留', expectedVersion: 4,
    sourceApplication: 'codex', sourceSessionId: 'session-1' });
  assert.deepEqual(f.sent.map(sent => sent.path), ['/api/knowledge/batch-confirmation', '/api/judgment/feedback']);
  assert.deepEqual(f.sent[0].body.items.map(item => [item.itemKind, item.itemId]), [['entity', 'fridays']]);
  assert.doesNotMatch(JSON.stringify(f.sent[0].body), new RegExp(SECRET));
  assert.equal(result.vote, 'down');
  const stored = f.service.store().get('s', unsure.id).feedback;
  assert.deepEqual({ vote: stored.vote, words: stored.personWords }, { vote: 'down', words: '保留' });
  assert.deepEqual(await listed(f), []);
});

test('an item that changed since the AI explained it is refused before anything changes', async t => {
  const f = fixture(t, { version: 6 });
  const asked = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  for (const choice of ['keep', 'drop']) {
    await assert.rejects(answer(f.app, { ...call, decisionId: asked.id, answer: choice, personWords: '不要了', expectedVersion: 5 }),
      error => error.code === 'stale_version');
  }
  assert.equal(changes(f), 0);
});

test('an option counts as agreeing with Tonborg only when it is the guessed action, and must mean the same answer', async t => {
  const f = fixture(t, { said: '保持当前记录' });
  const asked = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  await assert.rejects(answer(f.app, { ...call, decisionId: asked.id, answer: 'drop', personWords: '保持当前记录' }),
    /is the answer keep, not drop/);
  assert.equal(changes(f), 0);
  // Tonborg guessed drop; keeping it is a down vote, and the real check agrees.
  const kept = await answer(f.app, { ...call, decisionId: asked.id, answer: 'keep', personWords: '保持当前记录' });
  assert.equal(kept.vote, 'down');
  assert.equal(f.service.store().get('s', asked.id).feedback.vote, 'down');

  // An edit option on an edit guess is up, and the answered question does not come back.
  const g = fixture(t, { said: '补充或纠正信息：只在周一到周四部署' });
  const edited = g.ask('relationship:deploy', 'Deploy on Fridays', 'edit');
  const result = await answer(g.app, { ...call, decisionId: edited.id, answer: 'edit', personWords: '补充或纠正信息',
    newText: '只在周一到周四部署' });
  assert.equal(result.vote, 'up');
  assert.deepEqual(await listed(g), []);
});

test('drop and edit vote first, then change the item at the version read now', async t => {
  const f = fixture(t, { version: 7 });
  const dropped = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  const result = await answer(f.app, { ...call, decisionId: dropped.id, answer: 'drop', personWords: '不要了' });
  assert.deepEqual(f.sent.map(sent => sent.path), ['/api/judgment/feedback']);
  assert.deepEqual(f.revisions.map(({ itemKind, itemId, action, expectedVersion, operationActor }) =>
    ({ itemKind, itemId, action, expectedVersion, operationActor })),
  [{ itemKind: 'entity', itemId: 'fridays', action: 'invalidate', expectedVersion: 7, operationActor: 'agent' }]);
  assert.match(f.revisions[0].reason, /不要了/);
  assert.deepEqual([result.vote, f.service.store().get('s', dropped.id).feedback.vote], ['up', 'up']);

  const g = fixture(t, { version: 2, said: '改成：只在周一到周四部署' });
  const edited = g.ask('relationship:deploy', 'Deploy on Fridays', 'keep');
  await assert.rejects(answer(g.app, { ...call, decisionId: edited.id, answer: 'edit', personWords: '只在周一到周四部署' }),
    /newText is required/);
  await answer(g.app, { ...call, decisionId: edited.id, answer: 'edit', personWords: '只在周一到周四部署', newText: '只在周一到周四部署' });
  assert.deepEqual(g.revisions.map(({ action, fact, expectedVersion }) => ({ action, fact, expectedVersion })),
    [{ action: 'update', fact: '只在周一到周四部署', expectedVersion: 2 }]);
  assert.equal(g.service.store().get('s', edited.id).feedback.vote, 'down');
});

test('with the person\'s permission off, recording off, or words they did not say, nothing changes', async t => {
  const off = fixture(t, { permission: false });
  const a = off.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  for (const choice of ['keep', 'drop']) {
    await assert.rejects(answer(off.app, { ...call, decisionId: a.id, answer: choice, personWords: '不要了' }),
      error => error.code === 'delegation_category_off');
  }
  assert.equal(off.revisions.length, 0);

  const paused = fixture(t, { capture: false });
  const b = paused.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  await assert.rejects(answer(paused.app, { ...call, decisionId: b.id, answer: 'drop', personWords: '不要了' }),
    error => error.code === 'capture_disabled');
  assert.equal(changes(paused), 0);

  const unsaid = fixture(t, { said: '先别动，等我看完' });
  const c = unsaid.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  for (const choice of ['keep', 'drop']) {
    await assert.rejects(answer(unsaid.app, { ...call, decisionId: c.id, answer: choice, personWords: '不要了' }),
      error => error.code === 'person_words_not_found');
  }
  assert.equal(changes(unsaid), 0);
});

test('the tools are listed with their schemas and in the interface catalog', () => {
  assert.deepEqual(TONBORG_QUESTION_DEFINITIONS.map(tool => tool.name), ['list_tonborg_questions', 'answer_tonborg_question']);
  const [listSchema, answerSchema] = TONBORG_QUESTION_DEFINITIONS.map(tool => tool.inputSchema);
  assert.deepEqual(listSchema.required, ['personalSpaceId', 'taskContextToken']);
  assert.deepEqual(answerSchema.required, ['personalSpaceId', 'decisionId', 'answer', 'personWords', 'taskContextToken']);
  for (const schema of [listSchema, answerSchema]) assert.equal(schema.properties.projectAgentId, undefined);
  assert.ok(answerSchema.properties.newText && answerSchema.properties.expectedVersion);
  const domain = agentInterfaceCatalog().readWorkflows.find(entry => entry.domain === 'tonborg-questions');
  assert.deepEqual(domain.toolNames, ['list_tonborg_questions', 'answer_tonborg_question']);
});

test('Tonborg named without a project goes through every question the person sees, as the console lists them', async t => {
  // A plain session sees every project's items but not one FLA's own (the Provider's rule).
  const f = fixture(t, { task: TONBORG, said: '保留', visible: { '': ['entity:p-item', 'entity:q-item', 'entity:global'],
    'fla-1': ['entity:p-item', 'entity:global', 'entity:fla-own'] } });
  f.ask('entity:p-item', 'Project P item', 'keep');
  const other = f.ask('entity:q-item', 'Project Q item', 'drop', { project: 'q' });
  f.ask('entity:global', 'Global item', 'keep', { project: null });
  f.ask('entity:fla-own', 'An FLA\'s own item', 'keep');
  // The console's 「Tonborg 拿不准」: the person's own full read.
  const owner = { readVisibleKnowledgeItems: async ({ items }) => ({ items, states: items.map(item => ({ ...item, state: 'pending' })) }) };
  const consoleCount = (await delegatedReviewList({ judgment: f.service, personal: owner, input: { personalSpaceId: 's' } })).questions.length;
  const read = await list(f.app, call);
  assert.deepEqual(read.questions.map(question => question.item).sort(), ['Global item', 'Project P item', 'Project Q item']);
  assert.equal(read.total + read.hiddenCount, consoleCount);
  assert.equal(consoleCount, 4);
  // Another project's item is answered from the same task, at its version, behind the same gate.
  const result = await answer(f.app, { ...call, decisionId: other.id, answer: 'keep', personWords: '保留', expectedVersion: 3 });
  assert.deepEqual([result.status, f.sent.map(sent => sent.path)], ['done', ['/api/knowledge/batch-confirmation', '/api/judgment/feedback']]);
  assert.doesNotMatch(JSON.stringify(read), new RegExp(SECRET));
  // Any other FLA still reads in its own project only.
  const g = fixture(t, { task: FLA, visible: { 'fla-1': ['entity:p-item', 'entity:global', 'entity:q-item'] } });
  g.ask('entity:p-item', 'Project P item', 'keep');
  g.ask('entity:q-item', 'Project Q item', 'drop', { project: 'q' });
  assert.deepEqual(await listed(g), ['Project P item']);
});
