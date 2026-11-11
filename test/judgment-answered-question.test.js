import test from 'node:test';
import assert from 'node:assert/strict';
import { createJudgmentService } from '../src/judgment/service.js';
import { judgmentHumanInteraction } from '../src/judgment/conversation.js';

// Synthetic records only: a Tonborg escalation the person answered is not asked again.
function judgment(t) {
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    personal: { readVisibleKnowledgeItems: async ({ items }) => ({ items }) } };
  const service = createJudgmentService({ app }); t.after(() => service.close());
  const escalate = (key, evidenceFingerprint = key) => service.store().record('s', { personalProjectId: 'p', kind: 'review',
    outcome: 'escalate', target: 'entity:item', title: 'Item', summary: 'Keep or correct?', evidenceFingerprint }, key);
  // The question as an Agent's list of records asks it (a checkpoint's card names it only once).
  const ask = () => service.agent.records({ personalSpaceId: 's', personalProjectId: 'p' })
    .then(({ human_interaction }) => (human_interaction ? { human_interaction } : {}));
  return { service, escalate, ask };
}

test('an unanswered escalation is asked, naming the feedback route and revision that record the answer', async t => {
  const { escalate, ask } = judgment(t);
  const record = escalate('a');
  const { human_interaction } = await ask();
  assert.equal(human_interaction.source.id, record.id);
  assert.equal(human_interaction.source.feedbackRevision, 0);
  assert.match(human_interaction.guidance, /run_delegated_action, route "POST \/api\/judgment\/feedback"/);
});

test('an answered escalation is not asked again, by vote or by reason alone', async t => {
  const { service, escalate, ask } = judgment(t);
  const voted = escalate('voted');
  service.store().feedback('s', voted.id, 'up', '保持当前记录', 0);
  assert.deepEqual(await ask(), {});
  const corrected = escalate('corrected');
  service.store().feedback('s', corrected.id, null, '已补充来源', 0);
  assert.deepEqual(await ask(), {});
  assert.equal((await service.records({ personalSpaceId: 's', personalProjectId: 'p' })).human_interaction, undefined);
});

test('a review of the same evidence is covered by the answer; changed evidence is asked again', async t => {
  const { service, escalate, ask } = judgment(t);
  const first = escalate('first', 'evidence-1');
  service.store().feedback('s', first.id, 'up', '', 0);
  escalate('again', 'evidence-1');
  assert.deepEqual(await ask(), {});
  const changed = escalate('changed', 'evidence-2');
  assert.equal((await ask()).human_interaction.source.id, changed.id);
});

test('稍后处理 snoozes the question for 24 hours, then it is asked again', async t => {
  const { service, escalate, ask } = judgment(t);
  const record = escalate('later');
  service.store().feedback('s', record.id, null, '稍后处理', 0);
  assert.deepEqual(await ask(), {});
  const escalation = { id: 'r', kind: 'review', outcome: 'escalate', target: 'entity:item', summary: 'Keep or correct?',
    evidenceFingerprint: 'e', execution: { status: 'not_applied' } };
  const snoozedAt = hoursAgo => ({ revision: 1, vote: null, reason: '稍后处理', createdAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString() });
  assert.deepEqual(judgmentHumanInteraction([{ ...escalation, feedback: snoozedAt(23) }], 's'), {});
  assert.equal(judgmentHumanInteraction([{ ...escalation, feedback: snoozedAt(25) }], 's').human_interaction.source.id, 'r');
  // A vote withdrawn without a reason is no answer.
  assert.equal(judgmentHumanInteraction([{ ...escalation, feedback: { revision: 2, vote: null, reason: '' } }], 's')
    .human_interaction.source.id, 'r');
});

test('an escalation whose item the person already confirmed elsewhere is not asked, though nobody voted (11-06)', async t => {
  // The item's own state decides, not only the record's feedback: an escalate record with vote null about a preference
  // the person confirmed through 全部确认 or the knowledge page, as the checkpoint reads it.
  const states = new Map([['entity:item', 'pending']]);
  const app = { config: { personal: { spaceId: 's' } }, listPersonalProjects: async () => [{ project_id: 'p' }],
    personal: { readVisibleKnowledgeItems: async ({ items, with_state }) => ({ items,
      ...(with_state ? { states: items.map(item => ({ ...item, state: states.get(`${item.item_kind}:${item.item_id}`) })) } : {}) }) } };
  const service = createJudgmentService({ app }); t.after(() => service.close());
  const record = service.store().record('s', { personalProjectId: 'p', kind: 'review', outcome: 'escalate',
    target: 'entity:item', title: 'Synthetic brand colour preference', summary: 'Keep or correct?', evidenceFingerprint: 'e' }, 'k');
  // The question as an Agent's list of records asks it (a checkpoint's card names it only once).
  const ask = () => service.agent.records({ personalSpaceId: 's', personalProjectId: 'p' })
    .then(({ human_interaction }) => (human_interaction ? { human_interaction } : {}));
  assert.equal((await ask()).human_interaction.source.id, record.id);
  assert.equal(record.feedback.vote, null);
  for (const state of ['confirmed', 'historical']) {
    states.set('entity:item', state);
    assert.deepEqual(await ask(), {}, state);
  }
  // Tonborg's own confirmation does not answer the person's question.
  states.set('entity:item', 'agent_confirmed');
  assert.equal((await ask()).human_interaction.source.id, record.id);
});
