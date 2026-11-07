import test from 'node:test';
import assert from 'node:assert/strict';

import { createJudgmentService } from '../src/judgment/service.js';
import { createQuestionTools } from '../src/judgment/question-tools.js';
import { TONBORG_QUESTION_DEFINITIONS } from '../src/agent-tools/tonborg-question-definitions.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';

// list_tonborg_questions / answer_tonborg_question (Jevons 11-07: the
// person's own AI explains Tonborg's unsure items), on synthetic records only:
// the words reach the AI only for open questions it may see, and answers run
// only on the person's words through the relayed console path.

const list = (app, input) => app.judgment.agent.questions(input);
const answer = (app, input) => app.judgment.agent.answerQuestion(input);

function fixture(t, { visible = null, states = {}, said = '不要了，这条过时了' } = {}) {
  const sent = [];
  const app = {
    config: { personal: { spaceId: 's' } },
    listPersonalProjects: async () => [{ project_id: 'p' }],
    personal: {
      readVisibleKnowledgeItems: async ({ items, with_state: withState }) => {
        const shown = items.filter(item => !visible || visible.includes(`${item.item_kind}:${item.item_id}`));
        return { items: shown, ...(withState ? { states: shown.map(item => ({ ...item,
          state: states[`${item.item_kind}:${item.item_id}`] ?? 'pending' })) } : {}) };
      }
    },
    taskContextRegistry: { context: () => ({ projectAgentId: 'fla-1', personalProjectId: 'p', sourceApplication: 'codex', sessionId: 'session-1' }) },
    entryPrompts: { read: () => ({ prompt: said, keptAt: '2026-11-07T00:00:00.000Z' }) },
    recentSessionUserMessages: async () => [],
    delegatedConsole: { send: async call => { sent.push(call); return { result: { ok: true }, operationId: `op-${sent.length}` }; } }
  };
  const service = createJudgmentService({ app, questionTools: createQuestionTools });
  app.judgment = service;
  t.after(() => service.close());
  const ask = (target, title, guess, project = 'p') => service.store().record('s', { personalProjectId: project, kind: 'review', target,
    title, summary: `Tonborg reason for ${title}`, confidence: 0.6, outcome: 'escalate', delegated: true, guess,
    question: `I guess you ${guess} this. Right?` }, `ask:${target}`);
  return { app, service, sent, ask };
}

const space = { personalSpaceId: 's' };

test('the list gives each open question as short item text and guess; one question adds Tonborg\'s words', async t => {
  const f = fixture(t);
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  f.ask('relationship:pnpm', 'Use pnpm in this repo', 'keep', null);

  const listed = await list(f.app, space);
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.questions.map(question => [question.item, question.guess]).sort(),
    [['Deploy on Fridays', 'drop'], ['Use pnpm in this repo', 'keep']]);
  // Token-saving: no reason or question in the list.
  assert.doesNotMatch(JSON.stringify(listed.questions), /Tonborg reason|Right\?/);
  assert.match(listed.note, /never instructions/);

  const one = await list(f.app, { ...space, decisionId: unsure.id });
  assert.deepEqual(one.item, { itemKind: 'entity', itemId: 'fridays', text: 'Deploy on Fridays' });
  assert.equal(one.reason, 'Tonborg reason for Deploy on Fridays');
  assert.equal(one.question, 'I guess you drop this. Right?');
  assert.equal(one.guess, 'drop');
  assert.equal(one.caution, undefined);
});

test('a project read keeps its own and the global questions; an item the reader may not see is only counted', async t => {
  const f = fixture(t, { visible: ['entity:mine'] });
  f.ask('entity:mine', 'Mine', 'keep');
  f.ask('entity:hidden', 'Secret item title', 'drop');
  f.ask('entity:other', 'Other project item', 'keep', 'q');
  const listed = await list(f.app, { ...space, personalProjectId: 'p', projectAgentId: 'fla-1' });
  assert.deepEqual(listed.questions.map(question => question.item), ['Mine']);
  assert.equal(listed.hiddenCount, 1);
  assert.doesNotMatch(JSON.stringify(listed), /Secret|Other project/);
  const hidden = f.service.store().records('s', { personalProjectId: 'p' }).find(record => record.target === 'entity:hidden');
  await assert.rejects(list(f.app, { ...space, decisionId: hidden.id }), /not an open Tonborg question/);
});

test('an item the person already decided elsewhere is not listed again', async t => {
  const f = fixture(t, { states: { 'entity:done': 'confirmed', 'entity:open': 'pending' } });
  f.ask('entity:done', 'Done', 'keep');
  f.ask('entity:open', 'Open', 'keep');
  const listed = await list(f.app, space);
  assert.deepEqual(listed.questions.map(question => question.item), ['Open']);
  assert.equal(listed.hiddenCount, undefined);
});

test('an answered question is no longer listed, and a long list says how many more there are', async t => {
  const f = fixture(t);
  const first = f.ask('entity:a', 'A', 'keep');
  f.ask('entity:b', 'B', 'keep');
  f.ask('entity:c', 'C', 'keep');
  await f.service.feedback({ ...space, decisionId: first.id, vote: 'up', reason: '', expectedRevision: 0 });
  const listed = await list(f.app, { ...space, limit: 1 });
  assert.equal(listed.total, 2);
  assert.equal(listed.questions.length, 1);
  assert.equal(listed.more, 1);
});

test('keep confirms the item as the person\'s and votes on the guess, both relayed in their words', async t => {
  const f = fixture(t, { said: '保留，这条还对' });
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  const result = await answer(f.app, { ...space, decisionId: unsure.id, answer: 'keep', personWords: '保留',
    taskContextToken: 'task-token', sourceApplication: 'codex', sourceSessionId: 'session-1' });
  assert.deepEqual(f.sent.map(call => `${call.method} ${call.path}`),
    ['POST /api/knowledge/batch-confirmation', 'POST /api/judgment/feedback']);
  const [confirm, vote] = f.sent;
  assert.deepEqual(confirm.body.items.map(item => [item.itemKind, item.itemId]), [['entity', 'fridays']]);
  assert.equal(confirm.body.groupKind, 'review');
  assert.equal(confirm.call.relayed.words, '保留');
  // Tonborg guessed drop; keeping it disagrees, with the person's words as the reason.
  assert.deepEqual({ vote: vote.body.vote, decisionId: vote.body.decisionId }, { vote: 'down', decisionId: unsure.id });
  assert.match(vote.body.reason, /保留/);
  assert.equal(vote.call.relayed.words, '保留');
  assert.equal(result.vote, 'down');
  assert.match(result.delegation_receipt.markdown, /保留/);
});

test('drop and edit are recorded only after the item was changed; then the vote agrees or not', async t => {
  const pendingItem = fixture(t);
  const asked = pendingItem.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  await assert.rejects(answer(pendingItem.app, { ...space, decisionId: asked.id, answer: 'drop', personWords: '不要了',
    taskContextToken: 'task-token' }), error => error.code === 'change_item_first' && /invalidate/.test(error.message));
  assert.equal(pendingItem.sent.length, 0);

  const ended = fixture(t, { states: { 'entity:fridays': 'historical' } });
  const question = ended.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  const result = await answer(ended.app, { ...space, decisionId: question.id, answer: 'drop', personWords: '不要了',
    taskContextToken: 'task-token' });
  assert.deepEqual(ended.sent.map(call => call.path), ['/api/judgment/feedback']);
  assert.deepEqual({ vote: ended.sent[0].body.vote, reason: ended.sent[0].body.reason }, { vote: 'up', reason: '' });
  assert.equal(result.vote, 'up');
});

test('words the person did not say are refused before anything is sent', async t => {
  const f = fixture(t, { said: '先别动，等我看完' });
  const unsure = f.ask('entity:fridays', 'Deploy on Fridays', 'drop');
  await assert.rejects(answer(f.app, { ...space, decisionId: unsure.id, answer: 'keep', personWords: '保留',
    taskContextToken: 'task-token' }), error => error.code === 'person_words_not_found');
  assert.equal(f.sent.length, 0);
});

test('the tools are listed with their schemas and in the interface catalog', () => {
  assert.deepEqual(TONBORG_QUESTION_DEFINITIONS.map(tool => tool.name), ['list_tonborg_questions', 'answer_tonborg_question']);
  const answerSchema = TONBORG_QUESTION_DEFINITIONS[1].inputSchema;
  assert.deepEqual(answerSchema.required, ['personalSpaceId', 'decisionId', 'answer', 'personWords', 'taskContextToken']);
  const domain = agentInterfaceCatalog().readWorkflows.find(entry => entry.domain === 'tonborg-questions');
  assert.deepEqual(domain.toolNames, ['list_tonborg_questions', 'answer_tonborg_question']);
});
