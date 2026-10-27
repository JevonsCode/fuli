import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { groupChoiceReply, parseFlaMention } from '../src/graphiti/fla-mention.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { CONSOLE_LOCALES, consolePhrasings } from '../test-support/console-mention-phrasings.js';
import { createAgentRoundtable } from '../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

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
  for (const reply of ['开始', '好', 'ok', '可以', 'yes', '1 3 个方案', '第一个', 'go ahead and refactor', '13 apples',
    '一起看', '圆桌']) {
    assert.equal(groupChoiceReply(reply), null, reply);
  }
  // The mode rides on the confirmation: both labels the choice offers, or a short word.
  assert.deepEqual(groupChoiceReply('1 3 一起看'), { choices: [1, 3], mode: 'session' });
  assert.deepEqual(groupChoiceReply('2 3 开始 圆桌'), { choices: [2, 3], mode: 'roundtable' });
  for (const [prompt, mode] of [['@FLG 一起看', 'session'], ['@FLG 开始 在这个会话里一起看', 'session'],
    ['@FLG 在圆桌里分头回复', 'roundtable'], ['@FLG 开始，圆桌', 'roundtable']]) {
    assert.deepEqual(parseFlaMention(prompt), { group: { confirm: true, mode } }, prompt);
  }
  assert.deepEqual(parseFlaMention('@FLG 1 3 在这个会话里一起看'), { group: { choices: [1, 3], mode: 'session' } });
  // A question that mentions a mode is still a question.
  assert.deepEqual(parseFlaMention('@FLG #Nova Lane 一起看这个'), { group: { query: '#Nova Lane 一起看这个' } });
});

test('question only: recommends fitting FLAs with reasons, preselected, without the moderator or unwakeable FLAs', async () => {
  const { hook, memoryReads, tasks } = fixture();
  const entry = await hook('@FLG 讨论这个方案的产品体验和技术风险');
  assert.equal(entry.flg.status, 'choose');
  assert.equal(entry.human_interaction.presentation, 'host_native_multi_choice');
  assert.match(entry.human_interaction.guidance, /multi-select[\s\S]*mode_choice[\s\S]*"1 3 一起看"[\s\S]*@FLG/u);
  // Without a mode in the question the roundtable is preselected, as before mode 1.
  assert.deepEqual(entry.human_interaction.mode_choice, { question: '怎么一起工作？',
    options: ['在这个会话里一起看', '在圆桌里分头回复'], preselected: 2 });
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

test('the console\'s @FLG phrasings name their FLAs, and "recommend one more" adds one, in both locales', async () => {
  for (const locale of CONSOLE_LOCALES) {
    const copied = consolePhrasings(locale, 'Nova Lane', 'Pia Mo');
    const pair = await fixture().hook(`${copied.pair}这个方案`);
    assert.deepEqual(names(preselected(pair)), ['Nova Lane', 'Pia Mo'], locale);
    const more = await fixture().hook(`${copied.recommend}技术架构`);
    assert.deepEqual(names(preselected(more)), ['Nova Lane', 'Jamie Ash'], locale);
  }
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

test('@FLG 好 while a choice waits shows the same choice again instead of a new question', async () => {
  const { hook, calls } = fixture();
  const first = await hook('@FLG 讨论这个方案的产品体验和技术风险');
  for (const unclear of ['@FLG 好', '@FLG ok']) {
    const again = await hook(unclear);
    assert.equal(again.flg.status, 'choose');
    assert.match(again.flg.notice, /@FLG 开始/u);
    assert.deepEqual(options(again), options(first));
    assert.equal(again.flg.question, first.flg.question);
  }
  assert.equal(calls.filter(([kind]) => kind === 'confirm').length, 0);
  assert.equal((await hook('@FLG 开始')).flg.status, 'confirmed');
});

test('a start refused for lack of executors ends the choice: routing returns and @FLG opens a new choice', async () => {
  const { app, hook } = fixture();
  app.standingAssignments = { match: (_, text) => text.includes('部署') ? [{ matchedTerms: ['部署'],
    assignment: { assignmentId: 'sa-1', projectId: 'project-b', leadAgentId: 'ops', responsibility: '部署' } }] : [] };
  // The real roundtable keeps what the entry records; its synthetic host knows the moderator's task.
  const roundtable = createAgentRoundtable({ openStore: () => createRoundtableStore(), env: {}, clientAvailable: () => false,
    host: createFuliRoundtableHost({ config: { personal: { spaceId: SPACE } },
      listProjectAgents: async () => ROSTER.map(agent => ({ agentId: agent.agent_id,
        profile: { name: agent.profile.name, displayName: agent.profile.display_name, status: agent.profile.status,
          allowedClients: agent.profile.allowed_clients } })),
      taskContextRegistry: { context: async () => ({ projectAgentId: 'ada', personalProjectId: 'project-a',
        sourceApplication: 'claude_code' }) },
      personal: { recentAgentSessions: async () => [], listPersonalProjects: async () => [] } }) });
  Object.assign(app.roundtable, { recordGroupChoice: roundtable.recordGroupChoice,
    groupDiscussionStatus: roundtable.groupDiscussionStatus, ownerGroupDiscussion: roundtable.ownerGroupDiscussion,
    requestGroupFollowUp: roundtable.requestGroupFollowUp, ownerStopGroupDiscussion: roundtable.ownerStopGroupDiscussion });
  await hook('@FLG 讨论上线风险 Nova Lane Pia Mo');
  const requestId = (await hook('@FLG 开始')).flg.start.requestId;
  assert.equal((await hook('部署脚本怎么写')).context.personal_project_id, 'project-a');
  await assert.rejects(roundtable.discuss({ taskContextToken: 'synthetic', sourceApplication: 'claude_code',
    action: 'start', requestId }), error => error.code === 'flg_no_executor');
  assert.equal((await hook('部署脚本怎么写')).context.personal_project_id, 'project-b');
  assert.equal((await hook('@FLG 新的问题')).flg.status, 'choose');
  await roundtable.close();
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

// Mode 1 reads through the same methods the Agent tools call; this records
// them and serves synthetic tasks, standing assignments and knowledge.
function sameSessionFixture() {
  const setup = fixture();
  const { app, calls } = setup;
  app.personal.listProjectAgentTasks = async input => {
    calls.push(['tasks', input.agentId, input.limit]);
    return ['1', '2', '3', '4'].map(n => ({ task_id: `${input.agentId}-task-${n}`, personal_space_id: SPACE,
      personal_project_id: 'project-a', title: `${input.agentId} 的第 ${n} 个任务`, status: n === '1' ? 'running' : 'completed' }));
  };
  app.standingAssignments = { match: () => [], list: () => [{ assignmentId: 'sa-1', projectId: 'project-a',
    leadAgentId: 'qa', terms: ['回归测试'], responsibility: '每次发布前的回归测试' }] };
  app.searchKnowledge = async input => {
    calls.push(['search', input.agentToolName, input.personalProjectId, input.query]);
    return { facts: [], entities: [{ id: 'k-1', name: 'Release checklist', summary: 'release checklist steps',
      defined_project_id: input.personalProjectId, confirmation_status: 'confirmed' }] };
  };
  const memberSearches = () => calls.filter(([kind, tool]) => kind === 'search' && tool === 'flg_member_knowledge_index');
  return { ...setup, memberSearches };
}

test('mode 1: 一起看 loads a read-only index of each member into this session; nobody is woken, no memory is read', async () => {
  const { hook, calls, memoryReads, memberSearches, tasks } = sameSessionFixture();
  const choose = await hook('@FLG #Nova Lane #Pia Mo 一起看这个 "release checklist"');
  assert.equal(choose.flg.status, 'choose');
  assert.deepEqual(names(preselected(choose)), ['Nova Lane', 'Pia Mo']);
  // The question asked for this session, so that mode is preselected.
  assert.equal(choose.human_interaction.mode_choice.preselected, 1);
  const entry = await hook('@FLG 开始');
  assert.equal(entry.flg.status, 'together');
  // Nothing is recorded in the roundtable and nobody is woken.
  assert.deepEqual(calls.filter(([kind]) => ['confirm', 'follow_up'].includes(kind)), []);
  assert.equal(entry.flg.start, undefined);
  // The session's own Agent keeps working this turn.
  assert.deepEqual([entry.context.personal_project_id, entry.context.project_agent_id], ['project-a', 'ada']);
  const { context } = entry.flg;
  assert.deepEqual(context.members.map(member => member.agent_id), ['qa', 'pm']);
  const nova = context.members[0];
  assert.deepEqual(nova.projects, [['project-a', 'Alpha']]);
  assert.deepEqual(nova.standing, ['每次发布前的回归测试']);
  assert.deepEqual(nova.tasks, [['qa-task-1', 'qa 的第 1 个任务', 'running'], ['qa-task-2', 'qa 的第 2 个任务', 'completed'],
    ['qa-task-3', 'qa 的第 3 个任务', 'completed']]);
  assert.equal(context.members[1].standing, undefined);
  // Knowledge titles of the members' projects, searched once per project, without the members' names.
  assert.deepEqual(context.knowledge, [['project-a', [['k-1', 'Release checklist']]]]);
  assert.deepEqual(memberSearches().map(([, , project]) => project), ['project-a']);
  assert.doesNotMatch(memberSearches()[0][3], /Nova|Pia/u);
  // Working memory is never read, and the entry says it was withheld.
  assert.deepEqual(memoryReads().filter(([, , agent]) => agent !== 'ada'), []);
  assert.match(context.withheld, /private_agent_project/u);
  assert.match(context.read, /view_project_agent_task[\s\S]*search_current_project_knowledge/u);
  assert.match(entry.flg.guidance, /Nobody is woken[\s\S]*Read-only/u);
  // One receipt line names whose context was loaded.
  const line = '本会话已载入 2 位 @FLG 成员的上下文：Nova Lane、Pia Mo（工作记忆为各 FLA 私有，未载入）';
  assert.equal(entry.flg.notice, line);
  assert.ok(entry.agent_receipt.markdown.includes(line));
  assert.ok(tasks.at(-1).agentAssignment.match_basis.some(item => item.startsWith('flg_with:qa ')));
});

test('mode 1: later @FLG <text> reads the same members again; ordinary turns carry nothing; @FLG 结束 ends it', async () => {
  const { hook, memberSearches } = sameSessionFixture();
  await hook('@FLG Nova Lane、Pia Mo 一起看这个');
  assert.equal((await hook('@FLG 开始')).flg.status, 'together');
  const ordinary = await hook('先看看日志');
  assert.equal(ordinary.flg, undefined);
  const again = await hook('@FLG 再看看 "deploy runbook"');
  assert.equal(again.flg.status, 'together');
  assert.deepEqual(again.flg.context.members.map(member => member.name), ['Nova Lane', 'Pia Mo']);
  assert.equal(again.human_interaction, undefined);
  assert.match(memberSearches().at(-1)[3], /deploy runbook/u);
  const ended = await hook('@FLG 结束');
  assert.equal(ended.flg.status, 'ended');
  assert.match(ended.agent_receipt.markdown, /已结束本会话的 @FLG 一起看/u);
  assert.equal((await hook('@FLG 新的问题')).flg.status, 'choose');
});

test('mode is chosen at confirmation: the answer overrides the preselection either way', async () => {
  const toSession = sameSessionFixture();
  await toSession.hook('@FLG 讨论这个方案的产品体验和技术风险');
  const together = await toSession.hook('@FLG 1 2 在这个会话里一起看');
  assert.equal(together.flg.status, 'together');
  assert.deepEqual(toSession.calls.filter(([kind]) => kind === 'confirm'), []);
  const toRoundtable = sameSessionFixture();
  await toRoundtable.hook('@FLG Nova Lane、Pia Mo 一起看这个');
  const started = await toRoundtable.hook('1 2 圆桌');
  assert.equal(started.flg.status, 'confirmed');
  assert.deepEqual(toRoundtable.calls.find(([kind]) => kind === 'confirm')[1].members, ['qa', 'pm']);
  assert.equal(started.flg.context, undefined);
});

test('mode 1 offers members no roundtable wake could reach, and says so for the session\'s own FLA', async () => {
  const { hook } = sameSessionFixture();
  // Otto Cole only works in OpenCode: no wake client, but nothing is woken in this session.
  const choose = await hook('@FLG Otto Cole、Nova Lane、Ada Lead 一起看这个');
  assert.deepEqual(names(preselected(choose)), ['Otto Cole', 'Nova Lane']);
  assert.match(choose.flg.notice, /Ada Lead 无法参加：就是本会话的 FLA/u);
  const roundtable = await fixture().hook('@FLG Otto Cole、Nova Lane 讨论');
  assert.match(roundtable.flg.notice, /Otto Cole 无法参加：没有可唤醒它的执行器/u);
});

test('mode 1: a member whose tasks cannot be read is said so; the rest still loads', async () => {
  const { app, hook } = sameSessionFixture();
  const read = app.personal.listProjectAgentTasks;
  app.personal.listProjectAgentTasks = async input => {
    if (input.agentId === 'pm') throw Object.assign(new Error('synthetic outage'), { status: 503 });
    return read(input);
  };
  await hook('@FLG Nova Lane、Pia Mo 一起看这个');
  const entry = await hook('@FLG 开始');
  assert.equal(entry.flg.status, 'together');
  assert.equal(entry.flg.context.members[1].tasks, 'unavailable');
  assert.equal(entry.flg.context.members[0].tasks.length, 3);
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
  // Mode 1 adds mode_choice (two labels) and the mode to the guidance: 1,171 -> about 1,400 B.
  assert.ok(choice < 1_500, `choice ${choice}`);
  assert.ok(confirmation < 700, `confirmation ${confirmation}`);
  // Mode 1's index for two members, each with three tasks, plus one knowledge title: once per
  // confirmation or `@FLG <text>`, never on ordinary turns; full items are read on demand.
  const same = sameSessionFixture();
  await same.hook('@FLG Nova Lane、Pia Mo 一起看 "release checklist"');
  const together = size({ flg: (await same.hook('@FLG 开始')).flg });
  t.diagnostic(`mode 1 field for two members ${together} B`);
  assert.ok(together < 2_000, `together ${together}`);
});
