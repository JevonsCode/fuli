import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { notRecordedEvent } from '../src/conversations/transcript-capture-gap.js';
import { readOwnSessionRecords, readSessionRecords } from '../src/graphiti/session-records.js';

// rec#5 C6 "本会话记了什么". Synthetic Provider only: it plays the
// authoritative store, so the list is checked against what was stored.

const CONSOLE = 'http://127.0.0.1:3999';
const SESSION = 'synthetic-session-1';
const LIST = `${CONSOLE}/s/${SESSION}`;
// Local wall-clock moments, so HH:mm reads the same in any time zone.
const at = (hour, minute) => new Date(2026, 9, 20, hour, minute).toISOString();
const project = (id, name) => ({ id, name, temporary: false });

function turn(index, hour, minute, overrides = {}) {
  return { task_id: `task-${index}`, turn_id: `turn-${index}`, created_at: at(hour, minute),
    personal_project_id: 'thesis', conversation_id: 'conversation-1', capture_off: null,
    messages: [{ role: 'user', text: `第 ${index} 轮：引用格式怎么改`, created_at: at(hour, minute) },
      { role: 'assistant', text: `回答 ${index}`, created_at: at(hour, minute) }],
    not_recorded: [], ...overrides };
}

function item(id, overrides = {}) {
  return { item_kind: 'entity', item_id: id, version: 1, title: id, content: `Synthetic ${id}`, type: 'ProjectFact',
    profile_aspect: null, category: 'fact', scope: { kind: 'projects', projects: [project('thesis', '毕业论文')], status: 'set' },
    weight: null, tags: [], confirmation_status: 'pending', content_source: 'agent_inferred', change: 'created',
    episode_id: `episode-${id}`, task_id: 'task-2', recorded_at: at(10, 6), origin_project_id: 'thesis',
    conversation_id: 'conversation-1', excerpt: null, ...overrides };
}

const paused = { layer: 'session', reason: 'session_paused' };

// The console's read goes through its human-review port; here it reaches the same synthetic Provider.
const consoleRead = (application, input) => readSessionRecords(application,
  { sessionRecords: body => application.personal.readSessionRecords(body) }, input);

// C6-1/C6-4: six saved turns, a paused stretch of eight turns (6～13), two
// project facts and one preference whose words became its evidence.
function sessionRead() {
  const turns = [
    ...[1, 2, 3, 4, 5].map(index => turn(index, 10, index)),
    ...[6, 7, 8, 9, 10, 11, 12, 13].map(index => turn(index, 14, 30 + index, { capture_off: paused, messages: [],
      not_recorded: [{ content: notRecordedEvent(index * 10, index * 10 + 9, 'session_paused').content,
        created_at: at(14, 31 + index), after: at(14, 30 + index) }] })),
    turn(14, 15, 10)
  ];
  return { session_id: SESSION, source_application: 'codex', turns, truncated: false,
    projects: [project('thesis', '毕业论文')],
    items: [item('fact-a', { recorded_at: at(10, 2), task_id: 'task-1' }),
      item('fact-b', { change: 'updated', category: 'rule', confirmation_status: 'confirmed' }),
      item('cite', { profile_aspect: 'judgment_preference', category: 'judgment', content: '论文引用格式用 GB/T 7714',
        change: 'evidence', excerpt: '以后引用都按 GB/T 7714', recorded_at: at(10, 4), task_id: 'task-4' })] };
}

function app(read = sessionRead(), task = { token: 'fuli-task-b', sessionId: SESSION, sourceApplication: 'codex',
  personalProjectId: 'thesis' }) {
  const reads = [];
  return { reads, app: { consoleUrl: CONSOLE, config: { personal: { spaceId: 'space' } },
    personal: { readSessionRecords: async input => { reads.push(input); return structuredClone(read); } },
    taskContextRegistry: { context: async (token, client) => {
      assert.equal(client, 'codex');
      return token === task.token ? task : Promise.reject(new Error('unknown task'));
    } },
    readOwnSessionRecords(input) { return readOwnSessionRecords(this, input); } } };
}

test('C6-1: the list holds this session\'s 6 turns, 2 knowledge items and 1 preference evidence, each with time and project', async () => {
  const { app: application, reads } = app();
  const view = await consoleRead(application, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  assert.deepEqual(reads, [{ personal_space_id: 'space', source_application: 'codex', session_id: SESSION }]);
  assert.equal(view.total, 9);
  assert.deepEqual(view.entries.map(entry => [entry.number, entry.group]), [
    [1, 'transcript'], [2, 'transcript'], [3, 'transcript'], [4, 'transcript'], [5, 'transcript'], [6, 'transcript'],
    [7, 'knowledge'], [8, 'knowledge'], [9, 'preference_evidence']]);
  for (const entry of view.entries) {
    assert.ok(entry.at, `${entry.key} has its time`);
    assert.equal(entry.project.name, '毕业论文');
    assert.ok(entry.link.startsWith(`${LIST}?client=codex&item=space/`), 'each item opens in the session list');
  }
  assert.equal(view.entries[0].summary, '第 1 轮：引用格式怎么改');
  assert.deepEqual(view.entries.slice(6, 8).map(entry => [entry.type, entry.status]),
    [['新增 事实', 'pending'], ['更新 规则类', 'confirmed']]);
  assert.equal(view.entries[8].summary, '以后引用都按 GB/T 7714', 'the words used as evidence');
  assert.equal(view.session.url, LIST);
});

test('session deletion identity is passed through to the console but never added to the Agent reply', async () => {
  const read = sessionRead();
  read.deletion_target_id = 'opaque-provider-session-target';
  const { app: application } = app(read);
  const view = await consoleRead(application, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  assert.equal(view.session.deletionTargetId, read.deletion_target_id);
  const own = await readOwnSessionRecords(application, { taskContextToken: 'fuli-task-b', sourceApplication: 'codex' });
  assert.equal(JSON.stringify(own).includes(read.deletion_target_id), false);
});

test('C6-4: paused turns hold nothing and the list marks the stretch as HH:mm～HH:mm 暂停记录', async () => {
  const { app: application } = app();
  const view = await consoleRead(application, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  assert.ok(view.entries.every(entry => !/task-(6|7|8|9|1[0-3])$/.test(entry.key)));
  assert.deepEqual(view.stretches, [{ from: at(14, 36), to: at(15, 10), paused: true, reasons: [] }]);
  const { markdown } = await callAgentTool(application, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  assert.match(markdown, /\n— 14:36～15:10 暂停记录，这段没有任何记录\n6\. 会话原文｜15:10｜/);
});

test('a skipped stretch without a paused checkpoint is 未记录, and one off for another reason is not a pause', async () => {
  const read = sessionRead();
  read.turns = [turn(1, 9, 0), turn(2, 9, 30, { not_recorded: [{
    content: notRecordedEvent(0, 10, 'project_off').content, created_at: at(9, 20), after: at(9, 5) }] })];
  read.items = [];
  const view = await consoleRead(app(read).app, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  assert.deepEqual(view.stretches, [{ from: at(9, 5), to: at(9, 20), paused: false, reasons: ['project_off'] }]);
});

test('C6-2: the Agent lists the same numbered items, types, summaries and links as the page', async () => {
  const { app: application } = app();
  const page = await consoleRead(application, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  const answer = await callAgentTool(application, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  const lines = answer.markdown.split('\n');
  const numbered = lines.filter(line => /^\d+\. /.test(line));
  assert.equal(numbered.length, page.total);
  page.entries.forEach((entry, index) => {
    assert.ok(numbered[index].startsWith(`${entry.number}. ${entry.type}`), numbered[index]);
    assert.ok(numbered[index].includes(`「${entry.summary}」`) && numbered[index].endsWith(`[查看](<${entry.link}>)`));
  });
  assert.deepEqual(Object.keys(answer).sort(), ['markdown', 'total', 'truncated', 'url'],
    'the Agent gets the numbered list, not every saved word');
  assert.equal(lines[0], `FULI 本会话已记录 9 项（[查看清单](<${LIST}>)）：`);
  assert.ok(answer.markdown.includes(`\n7. 新增 事实·待确认｜10:02｜项目 毕业论文｜「Synthetic fact-a」｜[查看](<${LIST}?client=codex&item=space/entity%3Afact-a>)`));
  assert.match(answer.markdown, /\n9\. 偏好证据·待确认｜10:04｜项目 毕业论文｜「以后引用都按 GB\/T 7714」｜/);
});

test('C6-3: a knowledge item names the turn it came from, and the turn lists it with its own words', async () => {
  const view = await consoleRead(app().app, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  const evidence = view.entries.find(entry => entry.key === 'entity:cite');
  assert.equal(evidence.turn, 'turn:task-4');
  const source = view.entries.find(entry => entry.key === evidence.turn);
  assert.deepEqual(source.detail.items, ['entity:cite']);
  assert.equal(source.detail.messages[0].text, '第 4 轮：引用格式怎么改');
});

test('C6-5: asked from project B, records the session wrote in project A never reach B\'s context', async () => {
  const read = sessionRead();
  read.projects = [project('thesis', '毕业论文'), project('ledger', '家庭账本私密')];
  read.turns[0] = turn(1, 10, 1, { personal_project_id: 'ledger',
    messages: [{ role: 'user', text: '账本里的私密存款数字', created_at: at(10, 1) }] });
  read.items[0].task_id = 'task-2'; // the Provider names a turn's own project as its records' origin
  read.items.push(item('secret', { origin_project_id: 'ledger', task_id: 'task-1', content: '私密存款 12345',
    scope: { kind: 'projects', projects: [project('ledger', '家庭账本私密')], status: 'set' } }),
  item('secret-pref', { origin_project_id: 'ledger', profile_aspect: 'taste', category: 'taste',
    excerpt: '账本私密的话', task_id: 'task-1' }));
  const { app: application } = app(read);
  const answer = await callAgentTool(application, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  const visible = JSON.stringify(answer);
  for (const secret of ['私密', 'ledger', '12345', 'task-1"']) assert.ok(!visible.includes(secret), secret);
  assert.equal(answer.total, 8, 'renumbered without a gap or a count of what was left out');
  assert.deepEqual(answer.markdown.split('\n').filter(line => /^\d+\. /.test(line)).map(line => parseInt(line, 10)),
    [1, 2, 3, 4, 5, 6, 7, 8]);
  // The person's own console lists everything, by the person's permission.
  const page = await consoleRead(application, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  assert.equal(page.total, 11);
  assert.ok(JSON.stringify(page).includes('私密存款 12345'));
});

test('an Agent reads only the session of its own task, never one it names', async () => {
  const { app: application, reads } = app();
  await assert.rejects(callAgentTool(application, 'read_session_records', { taskContextToken: 'fuli-task-other',
    sourceApplication: 'codex' }));
  await callAgentTool(application, 'read_session_records', { taskContextToken: 'fuli-task-b', sourceApplication: 'codex',
    sessionId: 'someone-elses-session' });
  assert.deepEqual(reads.map(read => read.session_id), [SESSION]);
  const schema = listAgentTools().find(tool => tool.name === 'read_session_records').inputSchema;
  assert.deepEqual(Object.keys(schema.properties), ['taskContextToken']);
});

test('an Agent reads its session as its task\'s FLA, or as a plain session naming no FLA', async () => {
  const fla = app(sessionRead(), { token: 'fuli-task-b', sessionId: SESSION, sourceApplication: 'codex',
    personalProjectId: 'thesis', projectAgentId: 'writer' });
  await callAgentTool(fla.app, 'read_session_records', { taskContextToken: 'fuli-task-b', sourceApplication: 'codex' });
  assert.deepEqual(fla.reads, [{ personal_space_id: 'space', source_application: 'codex', session_id: SESSION,
    reader_project_id: 'thesis', reader_agent_id: 'writer' }]);
  const plain = app();
  await callAgentTool(plain.app, 'read_session_records', { taskContextToken: 'fuli-task-b', sourceApplication: 'codex' });
  assert.deepEqual(plain.reads, [{ personal_space_id: 'space', source_application: 'codex', session_id: SESSION }],
    'no proof and no FLA: the Provider reads it as a plain session');
});

test('an empty session says so and still links its list; a long one says it is cut', async () => {
  const read = { ...sessionRead(), turns: [], items: [], truncated: true };
  const { markdown } = await callAgentTool(app(read).app, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  assert.equal(markdown, `FULI 本会话还没有记录任何内容（[查看清单](<${LIST}>)）：\n会话较长，只列出了最近的记录；更早的记录没有列出。`);
});

test('the page reads only the active personal space', async () => {
  const { app: application, reads } = app();
  await assert.rejects(consoleRead(application, { personalSpaceId: 'other', sourceApplication: 'codex', sessionId: SESSION }),
    /active personal space/);
  assert.equal(reads.length, 0);
});

test('C6-5: a pause only project A\'s turns hold stays out of B\'s answer; one B\'s turns hold still shows', async () => {
  const read = sessionRead();
  read.projects.push(project('ledger', '家庭账本'));
  const off = (index, hour, minute, projectId) => turn(index, hour, minute, { personal_project_id: projectId,
    capture_off: paused, messages: [], not_recorded: [{ content: notRecordedEvent(index, index + 1, 'session_paused').content,
      created_at: at(hour, minute + 1), after: at(hour, minute) }] });
  // A's own pause 09:00～09:30 before any B turn; B's pause 14:36～15:10 stays as before.
  read.turns = [off(90, 9, 0, 'ledger'), turn(91, 9, 30, { personal_project_id: 'ledger' }), ...read.turns];
  const { markdown } = await callAgentTool(app(read).app, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  assert.doesNotMatch(markdown, /09:00|09:3\d|家庭账本|ledger/);
  assert.match(markdown, /— 14:36～15:10 暂停记录，这段没有任何记录/);
  const page = await consoleRead(app(read).app, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  assert.equal(page.stretches.length, 2, 'the person sees both pauses');
});

test('C6-5: records of turns with no project are their own scope, not visible from a named project', async () => {
  const read = sessionRead();
  read.turns.push(turn(20, 16, 0, { personal_project_id: null,
    messages: [{ role: 'user', text: '无项目时说的私事', created_at: at(16, 0) }] }));
  read.items.push(item('loose', { origin_project_id: null, task_id: 'task-20', content: '无项目的记录' }));
  const fromThesis = await callAgentTool(app(read).app, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  assert.doesNotMatch(fromThesis.markdown, /无项目/);
  assert.equal(fromThesis.total, 9);
  const fromNowhere = await callAgentTool(app(read, { token: 'fuli-task-b', sessionId: SESSION, sourceApplication: 'codex',
    personalProjectId: null }).app, 'read_session_records', { taskContextToken: 'fuli-task-b', sourceApplication: 'codex' });
  assert.equal(fromNowhere.total, 2);
  assert.match(fromNowhere.markdown, /无项目时说的私事/);
  assert.doesNotMatch(fromNowhere.markdown, /毕业论文|引用格式/);
});

// dot #263 P2-1: only what the reader may see sets a stretch's boundary.
test('a B pause followed by another project\'s turn ends at its own evidence, whatever A\'s time is', async () => {
  const answer = async aMinute => {
    const read = sessionRead();
    read.projects.push(project('ledger', '家庭账本'));
    read.turns = [turn(80, 9, 0, { capture_off: paused, messages: [], not_recorded: [{
        content: notRecordedEvent(1, 2, 'session_paused').content, created_at: at(9, 1), after: null }] }),
      turn(81, 9, aMinute, { personal_project_id: 'ledger' }), turn(82, 10, 0)];
    read.items = [];
    return (await callAgentTool(app(read).app, 'read_session_records', { taskContextToken: 'fuli-task-b',
      sourceApplication: 'codex' })).markdown;
  };
  const early = await answer(30);
  assert.match(early, /— 09:00～09:01 暂停记录/);
  assert.doesNotMatch(early, /09:30/);
  assert.equal(await answer(45), early, 'moving A\'s turn changes nothing B can see');
});

// dot #263 P2-2: one item, every source; the reader's own sources survive projection.
test('an item cited in A and then in B keeps B\'s own evidence and turn in B\'s answer', async () => {
  const read = sessionRead();
  read.projects.push(project('ledger', '家庭账本'));
  read.turns.push(turn(30, 16, 0, { personal_project_id: 'ledger', messages: [{ role: 'user', text: 'A 里说的' }] }));
  const shared = { change: 'created', episode_id: 'episode-a', task_id: 'task-30', recorded_at: at(16, 1),
    origin_project_id: 'ledger', conversation_id: 'conversation-a', excerpt: 'A 里的原话' };
  const own = { change: 'evidence', episode_id: 'episode-b', task_id: 'task-5', recorded_at: at(10, 5),
    origin_project_id: 'thesis', conversation_id: 'conversation-1', excerpt: 'B 里的原话' };
  read.items = [item('global-pref', { profile_aspect: 'taste', category: 'taste', ...shared, sources: [shared, own] })];
  const { markdown } = await callAgentTool(app(read).app, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  assert.match(markdown, /偏好证据·待确认｜10:05｜项目 毕业论文｜「B 里的原话」/);
  assert.doesNotMatch(markdown, /A 里|家庭账本|ledger/);
  // The person's list keeps both sources, so either turn's link finds the item.
  const page = await consoleRead(app(read).app, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  const entry = page.entries.find(candidate => candidate.key === 'entity:global-pref');
  assert.deepEqual(entry.detail.sources, [{ episode_id: 'episode-a', turn: 'turn:task-30' },
    { episode_id: 'episode-b', turn: 'turn:task-5' }]);
  assert.ok(page.entries.find(candidate => candidate.key === 'turn:task-5').detail.items.includes('entity:global-pref'),
    'the later turn lists what it cited');
});

// dot #263 P2-2 re-review: A, A, then B cite one preference; B keeps it, and
// the last same-project citation is still linked to its own turn.
test('after two citations in A, B\'s one citation keeps the item, and the last citation stays linked', async () => {
  const read = sessionRead();
  read.projects.push(project('ledger', '家庭账本'));
  const source = (episode, task, origin, minute, words) => ({ change: 'evidence', episode_id: episode, task_id: task,
    recorded_at: at(11, minute), origin_project_id: origin, conversation_id: null, excerpt: words });
  const sources = [source('e-a1', 'task-40', 'ledger', 1, 'A 一'), source('e-a2', 'task-41', 'ledger', 2, 'A 二'),
    source('e-b1', 'task-3', 'thesis', 3, 'B 的原话'), source('e-b2', 'task-4', 'thesis', 4, 'B 的最后一次')];
  read.items = [item('pref', { profile_aspect: 'taste', category: 'taste', ...sources[0], change: 'created', sources })];
  const { markdown } = await callAgentTool(app(read).app, 'read_session_records', { taskContextToken: 'fuli-task-b',
    sourceApplication: 'codex' });
  assert.match(markdown, /偏好证据·待确认｜11:03｜项目 毕业论文｜「B 的原话」/);
  assert.doesNotMatch(markdown, /A 一|A 二|家庭账本/);
  const page = await consoleRead(app(read).app, { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: SESSION });
  const entry = page.entries.find(candidate => candidate.key === 'entity:pref');
  assert.deepEqual(entry.detail.sources.at(-1), { episode_id: 'e-b2', turn: 'turn:task-4' });
  assert.ok(page.entries.find(candidate => candidate.key === 'turn:task-4').detail.items.includes('entity:pref'));
});
