import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptTopicProposal, topicOutcome } from '../src/graphiti/topic-proposals.js';
import { staffTopicTeam, teamNotice } from '../src/graphiti/topic-team-handoff.js';

// Synthetic Provider boundary: a grown topic, three conversations Astro
// holds, and a staffing route that hires whoever a task asks for.
function application({ existingProject = false, refuse = [], policyFails = false, conversationsFail = false, held = null } = {}) {
  const calls = [];
  const registered = new Map(existingProject
    ? [['garden', { project_id: 'garden', profile: { name: 'Garden', purpose: 'Mine', lifecycle: 'active' } }]] : []);
  const person = { implementation: 'Robin Stone', verification: 'Jamie Ash' };
  return { config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2797', calls, registered,
    topicPromotion: () => 'auto',
    upsertPersonalProject: async input => {
      registered.set(input.projectId, { project_id: input.projectId, scope_type: 'registered', profile: input.profile });
    },
    personal: {
      listPersonalProjects: async () => [...registered.values()],
      getPersonalProject: async (_, id) => registered.get(id),
      staffDefaultProjectLead: async () => ({ status: 'ready',
        agent: { agent_id: 'lead-1', profile: { name: 'Garden 负责人', display_name: 'Lyra North' } } }),
      conversationTriage: async (operation) => (operation === 'topics'
        ? { topics: [{ topic: 'Garden', count: 3, days: 2, declined_count: null }] }
        : { personal_project_id: 'garden', conversation_ids: ['c1', 'c2', 'c3'], knowledge: { moved: 4, kept: 0 } }),
      conversation: async (operation, input) => {
        calls.push(['conversations', input]);
        if (conversationsFail) throw new Error('synthetic read failure');
        return { conversations: held ?? [
          { id: 'c1', summary: 'Picked raised beds\nand a drip line.', last_activity: '2026-11-03T09:00:00Z' },
          { id: 'other', summary: 'Another topic', last_activity: '2026-11-04T09:00:00Z' },
          { id: 'c2', summary: '', last_activity: '2026-11-05T09:00:00Z' }] };
      },
      updateProjectAgentCoordinationPolicy: async input => {
        calls.push(['policy', input]);
        if (policyFails) throw new Error('synthetic policy failure');
        return input;
      },
      submitProjectAgentTask: async input => {
        calls.push(['task', input]);
        if (refuse.includes(input.work_kind)) throw new Error('synthetic staffing failure');
        const agent = input.lead_agent_id
          ? { agent_id: input.lead_agent_id, profile: { name: 'Garden 负责人', display_name: 'Lyra North' } }
          : { agent_id: `fla-${input.work_kind}`, profile: { name: input.recruitment_profile.name, display_name: person[input.work_kind] } };
        return { task: { task_id: `task-${input.work_kind}`, status: 'backlog' }, assigned_agent: agent, decision: 'recruited' };
      }
    } };
}

test('a grown topic gets a team from Bole and each person a handover task of their own, not started', async () => {
  const app = application();
  const promoted = await topicOutcome(app, 'garden', { sourceApplication: 'claude_code' });
  assert.deepEqual(promoted.team.handoffs.map(({ position, agent_id, name, task_id, status }) => [position, agent_id, name, task_id, status]), [
    ['lead', 'lead-1', 'Lyra North', 'task-project_context', 'backlog'],
    ['engineering', 'fla-implementation', 'Robin Stone', 'task-implementation', 'backlog'],
    ['verification', 'fla-verification', 'Jamie Ash', 'task-verification', 'backlog']]);
  const tasks = app.calls.filter(([kind]) => kind === 'task').map(([, input]) => input);
  assert.ok(tasks.every(task => task.start === false && task.duration === 'ongoing' && task.personal_project_id === 'garden'
    && task.source_application === 'claude_code'));
  assert.deepEqual(tasks.map(task => [task.title, task.staffing_intent, task.idempotency_key.replace(/:[0-9a-f]{16}:/, ':<formation>:')]), [
    ['接手「Garden」', 'reuse_preferred', 'topic-handoff:garden:<formation>:lead'],
    ['接手「Garden」：开发', 'new_durable', 'topic-handoff:garden:<formation>:engineering'],
    ['接手「Garden」：独立验收', 'new_durable', 'topic-handoff:garden:<formation>:verification']]);
  assert.equal(tasks[0].lead_agent_id, 'lead-1');
  assert.equal(tasks[1].coordinator_agent_id, 'lead-1');
  assert.deepEqual([tasks[1].recruitment_profile.name, tasks[1].recruitment_profile.work_kinds], ['Garden 开发', ['implementation']]);
  // The brief is an index: dates and one-line outcomes of this topic's conversations only.
  assert.equal(tasks[0].objective, [
    'Astro 的交接：话题「Garden」已成立为项目。',
    '此前由 Astro 接待：3 个会话（2026-11-03 至 2026-11-05），搬入项目 4 条知识。',
    '会话结果（新的在前）：',
    '- 2026-11-05 · 没有记录结果',
    '- 2026-11-03 · Picked raised beds and a drip line.',
    '另有 1 个会话没有列出。',
    '接手后：先用 search_current_project_knowledge 查搬来的知识，再定下一步；Astro 不再跟进这个话题。'].join('\n'));
  assert.match(tasks[2].objective, /^独立验收别人的实质性改动.*\n负责人：Lyra North。\n\nAstro 的交接：/);
  assert.doesNotMatch(tasks[0].objective, /Another topic/);
  // The new project hires without a confirmation each; nothing else in its policy is sent.
  assert.deepEqual(app.calls.find(([kind]) => kind === 'policy')[1],
    { personal_space_id: 'space', personal_project_id: 'garden', ask_before_recruitment: false });
  assert.equal(promoted.notice, 'FULI：话题「Garden」聊了 3 次、跨 2 天，已升级为项目「Garden」，搬了 4 条知识'
    + '，Bole 招了 2 人（开发 Robin Stone、独立验收 Jamie Ash），Astro 已交接给 3 人。'
    + '[改名、换上级或撤销](http://127.0.0.1:2797/employees/assistant?promoted=garden&topic=Garden)');
  // Whether they start now is the person's one click.
  assert.deepEqual(promoted.start_question, { ask: '「Garden」的团队现在就开工吗？', options: ['马上开工', '先不'], allow_other: true,
    on_yes: { tool: 'record_project_agent_task_activity', status: 'queued', summary: '你说马上开工', personal_project_id: 'garden',
      task_ids: ['task-project_context', 'task-implementation', 'task-verification'] } });
  assert.match(promoted.guidance, /start_question.*only the person answers/);
});

test('a project the person already had keeps its team: only its lead is briefed', async () => {
  const app = application({ existingProject: true });
  const formed = await acceptTopicProposal(app, { topic: 'garden' });
  assert.deepEqual(formed.team.handoffs.map(item => item.position), ['lead']);
  assert.equal(app.calls.some(([kind]) => kind === 'policy'), false);
  assert.equal(formed.start_question.on_yes.task_ids.length, 1);
});

test('a step that fails is reported and never undoes the formation', async () => {
  const refused = await topicOutcome(application({ refuse: ['verification'] }), 'garden');
  assert.equal(refused.status, 'promoted');
  assert.deepEqual(refused.team.handoffs.map(item => [item.position, item.status]),
    [['lead', 'backlog'], ['engineering', 'backlog'], ['verification', 'unavailable']]);
  assert.match(refused.notice, /Bole 招了 1 人（开发 Robin Stone），Astro 已交接给 2 人/);
  // The policy could not be saved: nobody is hired behind a confirmation the project still asks for.
  const held = await topicOutcome(application({ policyFails: true }), 'garden');
  assert.deepEqual(held.team.handoffs.map(item => item.position), ['lead']);
  // Astro's conversations could not be read: the brief keeps the counts.
  const blind = application({ conversationsFail: true });
  await topicOutcome(blind, 'garden');
  assert.equal(blind.calls.find(([kind]) => kind === 'task')[1].objective, [
    'Astro 的交接：话题「Garden」已成立为项目。', '此前由 Astro 接待：3 个会话，搬入项目 4 条知识。',
    '接手后：先用 search_current_project_knowledge 查搬来的知识，再定下一步；Astro 不再跟进这个话题。'].join('\n'));
});

test('the brief lists at most eight conversations and every handover text fits a task', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `c${index}`);
  const app = application({ held: ids.map((id, index) => ({ id, summary: 'x'.repeat(300),
    last_activity: `2026-11-${String(index + 1).padStart(2, '0')}T09:00:00Z` })) });
  await staffTopicTeam(app, { topic: 'T'.repeat(200), projectId: 'garden', created: true, conversationIds: ids,
    knowledgeMoved: 0, lead: { agent_id: 'lead-1', profile: { name: 'L' } } });
  const tasks = app.calls.filter(([kind]) => kind === 'task').map(([, task]) => task);
  assert.equal(tasks[0].objective.split('\n').filter(line => line.startsWith('- ')).length, 8);
  assert.match(tasks[0].objective, /另有 4 个会话没有列出。/);
  assert.ok(tasks.every(task => task.title.length <= 160 && task.objective.length <= 4096));
  assert.equal(teamNotice(null), '');
});

test('the same formation repeats the same tasks; a topic that grows into the project again is a new handover', async () => {
  const keys = async conversationIds => {
    const app = application();
    await staffTopicTeam(app, { topic: 'Garden', projectId: 'garden', created: false, conversationIds, knowledgeMoved: 0,
      lead: { agent_id: 'lead-1', profile: { name: 'L' } } });
    return app.calls.filter(([kind]) => kind === 'task').map(([, task]) => task.idempotency_key);
  };
  assert.deepEqual(await keys(['c2', 'c1']), await keys(['c1', 'c2']));
  assert.notDeepEqual(await keys(['c1', 'c2']), await keys(['c3', 'c4', 'c5']));
});

test('only a handover waiting in the backlog is offered to start', async () => {
  const app = application();
  const submit = app.personal.submitProjectAgentTask;
  app.personal.submitProjectAgentTask = async input => {
    const route = await submit(input);
    return input.work_kind === 'verification' ? { ...route, task: { ...route.task, status: 'blocked' } } : route;
  };
  const promoted = await topicOutcome(app, 'garden');
  assert.deepEqual(promoted.start_question.on_yes.task_ids, ['task-project_context', 'task-implementation']);
});
