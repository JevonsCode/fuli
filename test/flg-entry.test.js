import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { groupChoiceReply, parseFlaMention } from '../src/graphiti/fla-mention.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';

// rec#55 @FLG at task entry: members are recommended, named or both, chosen
// with a native multi-select (a numbered list elsewhere), confirmed, then
// handed to the session's own Agent as moderator. Synthetic Provider boundary
// only; no real data, client or model.

const SPACE = 'synthetic-space';
const PROJECTS = { 'project-a': 'Alpha', 'project-b': 'Beta' };
const FOLDER = { status: 'matched', basis: 'repository_root', personalProjectId: 'project-a' };

function fla(agentId, name, role, projectId, { responsibility = `${role}相关工作`, status = 'active',
  clients = ['codex', 'claude_code'], updated = '2026-10-20T00:00:00Z' } = {}) {
  return { agent_id: agentId, personal_space_id: SPACE, personal_project_id: null, memory_scope: 'reviewed_agent',
    updated_at: updated, assignments: [{ personal_project_id: projectId, status: 'active', updated_at: updated }],
    profile: { name: role, display_name: name, responsibility, status, allowed_clients: clients,
      work_kinds: ['project_context'], capabilities: [], agent_type: 'durable' } };
}

const ROSTER = [
  fla('ada', 'Ada Lead', '负责人', 'project-a', { updated: '2026-10-26T00:00:00Z' }),
  fla('pm', 'Pia Mo', '产品经理', 'project-a', { responsibility: '用户需求与体验设计' }),
  fla('dev', 'Jamie Ash', '开发', 'project-a', { responsibility: '后端开发与技术架构' }),
  fla('qa', 'Nova Lane', '测试', 'project-a', { responsibility: '测试与质量保障' }),
  fla('ops', 'Jamie Ash', '运维', 'project-b', { responsibility: '部署与监控' }),
  fla('oc', 'Otto Cole', '运维', 'project-a', { clients: ['opencode'] }),
  fla('gone', 'Gail Gone', '设计', 'project-a', { status: 'archived' })
];

function fixture({ folder = FOLDER } = {}) {
  const calls = [];
  const tasks = [];
  const find = id => structuredClone(ROSTER.find(agent => agent.agent_id === id));
  const app = new FederatedGraphApplication({ version: 1, personal: { providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'synthetic-test-token', principalId: 'synthetic-user', spaceId: SPACE }, workspaces: [] },
  { projectPathResolver: () => folder, fetchImpl: async () => { throw new Error('Unexpected Provider request'); } });
  app.taskContextRegistry = {
    current: async (session, source) => tasks.findLast(task => task.sessionId === session
      && task.sourceApplication === source) ?? null,
    begin: async input => { const task = { ...input, token: `fuli-task-synthetic-${tasks.length}` };
      tasks.push(task); return task; }
  };
  // The roundtable's owner side, as group-discussion.js keeps it: what the
  // person confirmed and asked, by request ID (test/group-discussion.test.js
  // covers the real one).
  const discussions = new Map();
  const NAMES = Object.fromEntries(ROSTER.map(agent => [agent.agent_id,
    `${agent.profile.display_name}（${agent.profile.name}）`]));
  app.roundtable = { pending: () => [], attentionReplies: () => [], taskEntryDelegation: () => null,
    recordGroupChoice: input => { calls.push(['confirm', input]);
      discussions.set(input.requestId, { ...input, status: 'confirmed', followUps: 0, chatId: null }); },
    groupDiscussionStatus: ({ requestId }) => {
      const found = discussions.get(requestId);
      return found ? { status: found.status, followUps: found.followUps, maxFollowUps: 5 } : null;
    },
    ownerGroupDiscussion: async ({ requestId }) => {
      const found = discussions.get(requestId);
      return found && { requestId, chatId: found.chatId, status: found.status,
        members: found.members.map(agentId => ({ agentId, name: NAMES[agentId] })) };
    },
    requestGroupFollowUp: input => { calls.push(['follow_up', input]);
      const found = discussions.get(input.requestId);
      if (found.followUps >= 5) return { refused: 'limit' };
      found.pending = input;
      return { recorded: true };
    },
    ownerStopGroupDiscussion: async ({ requestId }) => { calls.push(['stop', requestId]);
      const found = discussions.get(requestId);
      if (!found) return null;
      found.status = 'ended';
      return { chatId: found.chatId, status: 'ended' };
    } };
  Object.assign(app.personal, {
    listPersonalProjects: async () => Object.entries(PROJECTS).map(([id, name]) => ({ project_id: id,
      scope_type: 'registered', profile: { name } })),
    getPersonalProject: async (_, id) => ({ project_id: id, scope_type: 'registered', profile: { name: PROJECTS[id] } }),
    listProjectAgents: async (_, project) => { calls.push(['roster', project]); return structuredClone(ROSTER); },
    getProjectAgent: async (_, project, id) => {
      const agent = find(id);
      if (!agent) throw Object.assign(new Error('Not found'), { status: 404 });
      return agent;
    },
    resolveProjectAgentContext: async input => {
      calls.push(['resolve', input.personal_project_id, input.agent_id]);
      return { status: 'ready', reason: 'project_team_lead', agent: find(input.agent_id ?? 'ada') };
    },
    getProjectAgentMemory: async input => {
      calls.push(['memory', input.personalProjectId, input.agentId]);
      return { personal_space_id: SPACE, personal_project_id: input.personalProjectId, agent_id: input.agentId,
        scope: input.personalProjectId ? 'private_agent_project' : 'private_agent_global', revision: 0, current: null, history: [] };
    },
    collaborationPreferences: async (space, project, limit, agent) => ({ personal_space_id: space,
      personal_project_id: project, project_agent_id: agent, effective_preferences: [], global_preferences: [], conflicts: [] }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'ada' }),
    listProjectAgentAssignments: async () => [],
    listProjectAgentTasks: async () => []
  });
  app.searchKnowledge = async () => ({ facts: [], entities: [] });
  // What every client's prompt hook calls (Claude Code, Codex, OpenCode).
  const hook = (taskPrompt, extra = {}) => app.beginTaskContext({ projectPath: '/synthetic/alpha',
    sessionId: 'synthetic-session', sourceApplication: 'claude_code', taskPrompt, ...extra });
  const memoryReads = () => calls.filter(([kind]) => kind === 'memory');
  return { app, hook, calls, tasks, memoryReads, discussions };
}

const options = entry => entry.human_interaction.options;
const preselected = entry => entry.human_interaction.preselected.map(number => options(entry)[number - 1]);
const names = list => list.map(option => option.replace(/^\d+\. /u, '').split(' — ')[0]);
const bytes = value => Buffer.byteLength(JSON.stringify(compactTaskContext(value)));

test('parsing: @FLG and #FLG only at the start share the FLA parser; numbers or @FLG 开始 answer the member choice', () => {
  assert.deepEqual(parseFlaMention('@FLG 讨论这个方案'), { group: { query: '讨论这个方案' } });
  assert.deepEqual(parseFlaMention('@flg：讨论'), { group: { query: '讨论' } });
  assert.deepEqual(parseFlaMention('#FLG 讨论一下'), { group: { query: '讨论一下' } });
  assert.deepEqual(parseFlaMention('@FLG 1 3'), { group: { choices: [1, 3] } });
  for (const confirm of ['@FLG 开始', '@FLG go', '#FLG 确认']) assert.deepEqual(parseFlaMention(confirm), { group: { confirm: true } });
  assert.deepEqual(parseFlaMention('@FLG 结束'), { group: { release: true } });
  assert.equal(parseFlaMention('@FLGX 不是').group, undefined);
  for (const prompt of ['请让 @FLG 讨论', '请 #FLG 讨论一下', '`@FLG 讨论`']) assert.equal(parseFlaMention(prompt), null, prompt);
  // The review's repros: none is a group; a leading @Name keeps its D-68a meaning.
  assert.deepEqual(parseFlaMention('@Jamie 帮我看看 #FLG 的解析'), { explicit: false, query: 'Jamie 帮我看看 #FLG 的解析' });
  assert.equal(parseFlaMention('fix the parser for #FLG and #FLA').group, undefined);
  assert.equal(parseFlaMention('see code: #FLG: x'), null);
  // `#FLA` mid-prompt still names the picker, but not inside code.
  assert.equal(parseFlaMention('改一下 `#FLA` 的解析'), null);
  assert.equal(parseFlaMention('改一下\n```\n#FLA x\n```'), null);
  for (const [reply, expected] of [['1 3', [1, 3]], ['1,3', [1, 3]], ['1、3', [1, 3]], ['2 3 开始', [2, 3]],
    ['3 1 1', [3, 1]], [' 4 ', [4]], ['1，2。', [1, 2]]]) {
    assert.deepEqual(groupChoiceReply(reply), { choices: expected }, reply);
  }
  // A bare word is ordinary talk, never a confirmation.
  for (const reply of ['开始', '好', 'ok', '可以', 'yes', '1 3 个方案', '第一个', 'go ahead and refactor', '13 apples']) {
    assert.equal(groupChoiceReply(reply), null, reply);
  }
});

test('question only: recommends fitting FLAs with reasons, preselected, without the moderator or unwakeable FLAs', async () => {
  const { hook, memoryReads, tasks } = fixture();
  const entry = await hook('@FLG 讨论这个方案的产品体验和技术风险');
  assert.equal(entry.flg.status, 'choose');
  assert.equal(entry.human_interaction.presentation, 'host_native_multi_choice');
  assert.match(entry.human_interaction.guidance, /multi-select[\s\S]*"1 3"[\s\S]*@FLG/u);
  const shown = names(options(entry));
  assert.ok(shown.length >= 2 && shown.length <= 4);
  assert.deepEqual(shown.slice(0, 2), ['Pia Mo', 'Jamie Ash']);
  assert.match(options(entry)[0], /职业「产品经理」与问题相关/u);
  assert.match(options(entry)[1], /职责涉及「技术」/u);
  for (const absent of ['Ada Lead', 'Otto Cole', 'Gail Gone']) assert.ok(!shown.includes(absent), absent);
  assert.deepEqual(names(preselected(entry)), shown);
  // No Agent works, and no memory is read, before the person confirms.
  assert.equal(entry.context.project_agent_id ?? null, null);
  assert.equal(entry.context.personal_project_id, 'project-a');
  assert.deepEqual(memoryReads(), []);
  assert.ok(tasks.at(-1).agentAssignment.match_basis.some(item => item.startsWith('flg_question:')));
  assert.ok(bytes(entry) < 16_000);
});

test('a standing assignment the question names recommends its lead first', async () => {
  const { app, hook } = fixture();
  app.standingAssignments = { match: () => [{ matchedTerms: ['工时'],
    assignment: { leadAgentId: 'qa', projectId: 'project-a', responsibility: '工时填报' } }] };
  const entry = await hook('@FLG 工时填报怎么改进体验');
  assert.equal(names(options(entry))[0], 'Nova Lane');
  assert.match(options(entry)[0], /长期负责「工时」/u);
});

test('named members are preselected and never replaced; more are only offered unchecked', async () => {
  const { hook } = fixture();
  const entry = await hook('@FLG Nova Lane、Pia Mo，一起讨论这个方案');
  assert.deepEqual(names(preselected(entry)), ['Nova Lane', 'Pia Mo']);
  assert.match(options(entry)[0], /点名/u);
  assert.ok(options(entry).length <= 4);
  // An unavailable named FLA is said with its reason and nobody takes its place.
  const refused = await fixture().hook('@FLG Gail Gone、Otto Cole、Nova Lane 讨论发布节奏');
  assert.match(refused.flg.notice, /Gail Gone 无法参加：已被解雇，未改用其他 FLA/u);
  assert.match(refused.flg.notice, /Otto Cole 无法参加：没有可唤醒它的执行器/u);
  assert.deepEqual(names(preselected(refused)), ['Nova Lane']);
  assert.ok(!names(options(refused)).includes('Gail Gone'));
});

test('named members plus "recommend more": keeps the named and adds checked recommendations', async () => {
  const { hook } = fixture();
  const entry = await hook('@FLG 让 Nova Lane 参加，再推荐一位懂技术架构的');
  assert.deepEqual(names(preselected(entry)), ['Nova Lane', 'Jamie Ash']);
  assert.equal(options(entry).length, 2);
  assert.match(options(entry)[1], /职责涉及「技术」/u);
});

test('a name several FLAs share offers each of them unchecked to pick from', async () => {
  const { hook } = fixture();
  const entry = await hook('@FLG Jamie Ash 和 Nova Lane 讨论上线风险');
  const same = options(entry).filter(option => option.includes('Jamie Ash'));
  assert.equal(same.length, 2);
  assert.ok(same.every(option => /同名，请选择/u.test(option)));
  assert.match(same.join('\n'), /Alpha — 开发[\s\S]*Beta — 运维|Beta — 运维[\s\S]*Alpha — 开发/u);
  assert.deepEqual(names(preselected(entry)), ['Nova Lane']);
  assert.match(entry.human_interaction.question, /同名/u);
});

test('confirming by numbers hands the chosen members to the session\'s own Agent as moderator', async () => {
  const { hook, tasks, calls } = fixture();
  const choose = await hook('@FLG Jamie Ash 和 Nova Lane 讨论上线风险');
  const shown = options(choose);
  const ops = shown.findIndex(option => option.includes('Beta — 运维')) + 1;
  const nova = shown.findIndex(option => option.includes('Nova Lane')) + 1;
  const confirmed = await hook(`${ops} ${nova}`);
  assert.equal(confirmed.flg.status, 'confirmed');
  assert.match(confirmed.flg.start.requestId, /^flg-/u);
  // What the person confirmed is recorded server-side; start runs exactly that.
  assert.deepEqual(calls.filter(([kind]) => kind === 'confirm').map(([, input]) => input), [{
    requestId: confirmed.flg.start.requestId, agentId: 'ada', projectId: 'project-a',
    question: 'Jamie Ash 和 Nova Lane 讨论上线风险', members: ['ops', 'qa'] }]);
  assert.match(confirmed.flg.guidance, /group_discussion[\s\S]*never write or guess/u);
  // The moderator is the folder's own Agent, with a task token for group_discussion.
  assert.deepEqual([confirmed.context.personal_project_id, confirmed.context.project_agent_id], ['project-a', 'ada']);
  assert.ok(confirmed.taskContextToken);
  assert.ok(tasks.at(-1).agentAssignment.match_basis.includes(`flg_group:${confirmed.flg.start.requestId}`));
});

test('the preselection is confirmed with @FLG 开始, never a bare word; bad numbers ask again', async () => {
  const one = fixture();
  await one.hook('@FLG 讨论这个方案的产品体验和技术风险');
  assert.equal((await one.hook('好')).flg, undefined);
  const zero = fixture();
  await zero.hook('@FLG 讨论这个方案的产品体验和技术风险');
  const go = await zero.hook('@FLG 开始');
  assert.equal(go.flg.status, 'confirmed');
  assert.deepEqual(zero.calls.find(([kind]) => kind === 'confirm')[1].members.slice(0, 2), ['pm', 'dev']);
  const two = fixture();
  await two.hook('@FLG 讨论这个方案的产品体验和技术风险');
  const unknown = await two.hook('@FLG 1 9');
  assert.equal(unknown.flg.status, 'choose');
  assert.match(unknown.flg.notice, /没有编号 9/u);
  const single = await two.hook('1');
  assert.equal(single.flg.status, 'choose');
  assert.match(single.flg.notice, /至少选两位/u);
  const host = await two.hook('@FLG 1 2');
  assert.equal(host.flg.status, 'confirmed');
  // An unrelated prompt drops the unanswered choice.
  const three = fixture();
  await three.hook('@FLG 讨论这个方案的产品体验和技术风险');
  await three.hook('先看看日志');
  assert.equal((await three.hook('1 2')).flg, undefined);
});

test('while the session\'s discussion exists, @FLG records the person\'s follow-up and @FLG 结束 stops it', async () => {
  const { hook, calls, discussions } = fixture();
  await hook('@FLG 讨论上线风险 Nova Lane Pia Mo');
  const requestId = (await hook('@FLG 开始')).flg.start.requestId;
  // A follow-up before the moderator started the discussion is not recorded.
  assert.equal((await hook('@FLG 还没开始就追问')).flg.reason, 'not_started');
  Object.assign(discussions.get(requestId), { chatId: 'local:chat-1', status: 'concluded' });
  const all = await hook('@FLG 如果流量翻倍呢？');
  assert.equal(all.flg.status, 'follow_up');
  assert.equal(all.flg.chat_id, 'local:chat-1');
  assert.equal(all.flg.to, undefined);
  assert.equal(all.human_interaction, undefined);
  const one = await hook('@FLG Nova Lane 你怎么看测试覆盖？');
  assert.equal(one.flg.to, 'qa');
  assert.deepEqual(calls.filter(([kind]) => kind === 'follow_up').map(([, input]) => input), [
    { requestId, body: '如果流量翻倍呢？', to: null }, { requestId, body: 'Nova Lane 你怎么看测试覆盖？', to: 'qa' }]);
  // Ordinary turns in between keep the discussion for later @FLG turns.
  await hook('先看看日志');
  const stopped = await hook('@FLG 结束');
  assert.equal(stopped.flg.status, 'stopped');
  assert.deepEqual(calls.filter(([kind]) => kind === 'stop'), [['stop', requestId]]);
  assert.match(stopped.flg.guidance, /summary/u);
  // Once ended the marker is not carried: the next @FLG chooses members again.
  assert.equal((await hook('@FLG 新的问题')).flg.status, 'choose');
});

test('after five follow-ups the person starts a new @FLG', async () => {
  const { hook, discussions } = fixture();
  await hook('@FLG 讨论上线风险 Nova Lane Pia Mo');
  const requestId = (await hook('@FLG 开始')).flg.start.requestId;
  Object.assign(discussions.get(requestId), { chatId: 'local:chat-1', status: 'concluded', followUps: 5 });
  const capped = await hook('@FLG 再问一次');
  assert.equal(capped.flg.reason, 'follow_up_limit');
  assert.equal((await hook('@FLG 换个问题')).flg.status, 'choose');
});

test('standing routing is bypassed only on @FLG turns and while the discussion is in progress', async () => {
  const { app, hook, discussions } = fixture();
  app.standingAssignments = { match: (_, text) => text.includes('部署') ? [{ matchedTerms: ['部署'],
    assignment: { assignmentId: 'sa-1', projectId: 'project-b', leadAgentId: 'ops', responsibility: '部署' } }] : [] };
  await hook('@FLG 讨论上线风险 Nova Lane Pia Mo');
  const requestId = (await hook('@FLG 开始')).flg.start.requestId;
  Object.assign(discussions.get(requestId), { chatId: 'local:chat-1', status: 'running' });
  assert.equal((await hook('部署脚本怎么写')).context.personal_project_id, 'project-a');
  discussions.get(requestId).status = 'concluded';
  assert.equal((await hook('部署脚本怎么写')).context.personal_project_id, 'project-b');
  discussions.get(requestId).status = 'ended';
  assert.equal((await hook('部署脚本怎么写')).context.personal_project_id, 'project-b');
});

test('outside a project nothing is started and the reason is said', async () => {
  const { hook } = fixture({ folder: { status: 'unmatched', personalProjectId: null } });
  const entry = await hook('@FLG 讨论一下');
  assert.equal(entry.flg.status, 'unavailable');
  assert.equal(entry.flg.reason, 'project_required');
  assert.equal(entry.human_interaction, undefined);
});

test('a bare @FLG asks for the question; @FLG 1 3 without a choice says so', async () => {
  assert.equal((await fixture().hook('@FLG')).flg.reason, 'question_required');
  assert.equal((await fixture().hook('@FLG 1 3')).flg.reason, 'no_choice');
});

test('token budget: an ordinary prompt carries nothing new; the member choice and the confirmation stay small', async t => {
  const plain = await fixture().hook('讨论这个方案的产品体验和技术风险');
  assert.equal(plain.flg, undefined);
  assert.equal(plain.human_interaction, undefined);
  const { hook } = fixture();
  const choose = await hook('@FLG 讨论这个方案的产品体验和技术风险');
  const confirm = await hook('@FLG 开始');
  const size = value => Buffer.byteLength(JSON.stringify(value));
  const choice = size({ flg: choose.flg, human_interaction: choose.human_interaction });
  const confirmation = size({ flg: confirm.flg });
  t.diagnostic(`choice fields ${choice} B, confirmation field ${confirmation} B, choice entry ${bytes(choose)} B`);
  assert.ok(choice < 1_400, `choice ${choice}`);
  assert.ok(confirmation < 700, `confirmation ${confirmation}`);
});
