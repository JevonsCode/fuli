import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { createAgentWorkflows } from '../src/agent-workflows/port.js';
import { flaGrowthEntry } from '../src/fla-growth/entry-hint.js';

// The person's "下次也这样做" over one completed delivery: the same versioned
// workflows as rec#60 D-78, with a lesson (trigger, scope, pitfalls, acceptance
// evidence), the person's verified affirmative words and the completed delivery
// FULI resolved itself. Same-project sessions discover a bounded compact index;
// no other project and no other FLA's private workflow is readable. Synthetic
// spaces, projects, conversations and words only.

const SPACE = 'space-a';
const OWNER = Object.freeze({ personalSpaceId: SPACE, agentId: 'fla-builder', personalProjectId: 'project-a' });
const SAME_FLA_ELSEWHERE = Object.freeze({ ...OWNER, personalProjectId: 'project-b' });
const READER = Object.freeze({ ...OWNER, agentId: 'fla-reader' });
const OUTSIDE = Object.freeze({ ...OWNER, personalProjectId: 'project-b', agentId: 'fla-outside' });
const STEPS = [{ title: 'Run the focused tests' }, { title: 'Run the full suite once', detail: 'Only after the focused ones pass' }];
const LESSON = Object.freeze({
  trigger: 'When a release build needs checking',
  scope: 'This project only',
  pitfalls: ['Do not start with the full suite'],
  acceptanceEvidence: ['The focused suite passed before the full suite']
});
const DELIVERY = Object.freeze({ conversationId: 'conversation-delivery', revision: 3 });
const approval = (agentId = OWNER.agentId) => ({ relayedBy: agentId, words: '下次也这样做',
  messageRef: { source: 'current_turn', taskId: null, conversationId: null, at: '2026-11-25T00:00:00.000Z' } });

function workflowsIn(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-agent-workflow-lessons-'));
  const path = join(directory, 'agent-workflows.sqlite');
  let tick = 0;
  const workflows = createAgentWorkflows({ path, now: () => new Date(Date.UTC(2026, 10, 25, 0, 0, tick++)) });
  t.after(() => { workflows.close(); rmSync(directory, { recursive: true, force: true }); });
  return { workflows, path, directory };
}

const proposal = (overrides = {}) => ({ name: 'Check a release build', purpose: 'Check a synthetic release before it ships',
  steps: STEPS, source: 'lesson', lesson: LESSON, delivery: DELIVERY, approval: approval(), ...overrides });

test('a lesson the person asked to keep is active at once, with its delivery on the immutable version', (t) => {
  const { workflows, path } = workflowsIn(t);
  const kept = workflows.propose(OWNER, proposal());
  assert.deepEqual([kept.status, kept.confirmedBy, kept.version], ['confirmed', 'person_words', 1]);
  assert.deepEqual(kept.workflow.lesson, { trigger: LESSON.trigger, scope: LESSON.scope });

  const read = workflows.read(OWNER, { workflowId: kept.workflow.workflowId });
  assert.deepEqual([read.version, read.lesson, read.steps], [1, LESSON, STEPS]);
  assert.equal(Object.hasOwn(read, 'approval'), false, 'the read does not repeat the person\'s words');
  assert.equal(Object.hasOwn(read, 'delivery'), false, 'the read does not repeat the private delivery id');

  const [view] = workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows;
  assert.deepEqual([view.status, view.active.lesson], ['active', LESSON]);
  assert.deepEqual([view.active.approval.relayedBy, view.active.approval.words], [OWNER.agentId, '下次也这样做']);
  assert.deepEqual(view.active.delivery, DELIVERY);

  workflows.close();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT count(*) AS count FROM agent_workflow_decisions WHERE decision = \'confirm\'').get().count, 1);
    const row = database.prepare('SELECT lesson, approval, delivery FROM agent_workflow_versions WHERE version = 1').get();
    assert.deepEqual(JSON.parse(row.lesson), LESSON);
    assert.equal(JSON.parse(row.approval).messageRef.source, 'current_turn');
    assert.deepEqual(JSON.parse(row.delivery), DELIVERY);
  } finally { database.close(); }
});

test('a lesson names its completed delivery; ordinary proposals and experience drafts keep their contracts', (t) => {
  const { workflows } = workflowsIn(t);
  const withLesson = (lesson, extra = {}) => proposal({ lesson, ...extra });
  assert.throws(() => workflows.propose(OWNER, withLesson({ ...LESSON, trigger: '' })), { code: 'invalid_input' });
  assert.throws(() => workflows.propose(OWNER, withLesson({ ...LESSON, scope: '' })), { code: 'invalid_input' });
  assert.throws(() => workflows.propose(OWNER, withLesson({ ...LESSON, acceptanceEvidence: [] })), { code: 'invalid_input' });
  assert.throws(() => workflows.propose(OWNER, withLesson({ ...LESSON, pitfalls: Array.from({ length: 7 }, () => 'x') })), /at most 6/);
  // Free-form evidence is not a delivery reference.
  assert.throws(() => workflows.propose(OWNER, withLesson(LESSON, { delivery: null })), /completed delivery/);
  assert.throws(() => workflows.propose(OWNER, withLesson(LESSON, { delivery: { revision: 1 } })), { code: 'invalid_input' });
  // A lesson belongs to one project.
  assert.throws(() => workflows.propose({ ...OWNER, personalProjectId: null }, proposal()), /project/);
  // Delivery belongs to a lesson only; ordinary proposals are unchanged.
  assert.throws(() => workflows.propose(OWNER, { name: 'n', purpose: 'p', steps: STEPS, source: 'agent', delivery: DELIVERY }),
    /belongs to a lesson/);
  const ordinary = workflows.propose(OWNER, { name: 'n', purpose: 'p', steps: STEPS, source: 'agent' });
  assert.equal(ordinary.status, 'proposed');
  // The 3-kept-experiences draft is a different proposal and still needs its workMap.
  assert.throws(() => workflows.propose(OWNER, { name: 'n', purpose: 'p', steps: STEPS, source: 'experiences:abc' }), /workMap/);
  assert.throws(() => workflows.propose(OWNER, { ...proposal(), source: 'experiences:abc',
    workMap: { inputs: ['i'], outputs: ['o'], acceptance: ['a'] } }), /different proposals/);
});

test('the same completed delivery kept twice adds no version, even from a second connection', (t) => {
  const { workflows, path } = workflowsIn(t);
  const first = workflows.propose(OWNER, proposal());
  assert.equal(workflows.propose(OWNER, proposal()).status, 'unchanged');

  const second = createAgentWorkflows({ path });
  const retry = second.propose(OWNER, proposal());
  second.close();
  assert.equal(retry.status, 'unchanged');
  assert.equal(retry.workflow.workflowId, first.workflow.workflowId);
  const [view] = workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows;
  assert.deepEqual([view.versionCount, view.active.version], [1, 1]);
});

test('retiring the lesson removes it; a same-source replay says retired and does not bring it back', (t) => {
  const { workflows } = workflowsIn(t);
  const kept = workflows.propose(OWNER, proposal());
  assert.equal(workflows.decide({ personalSpaceId: SPACE, workflowId: kept.workflow.workflowId,
    decision: 'retire', version: 1 }).status, 'retired');
  assert.equal(workflows.index(READER).lessons, undefined);
  assert.throws(() => workflows.read(READER, { workflowId: kept.workflow.workflowId }), { code: 'workflow_not_found' });
  assert.throws(() => workflows.decide({ personalSpaceId: 'space-b', workflowId: kept.workflow.workflowId,
    decision: 'retire', version: 1 }), { code: 'workflow_not_found' });

  const replay = workflows.propose(OWNER, proposal());
  assert.deepEqual([replay.status, replay.workflow.workflowId], ['retired', kept.workflow.workflowId]);
  const [view] = workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows;
  assert.deepEqual([view.status, view.versionCount, view.active], ['retired', 1, null], 'no version was resurrected');
});

test('the index lists other FLAs\' lessons in this project only, bounded, with steps on demand', (t) => {
  const { workflows } = workflowsIn(t);
  const kept = workflows.propose(OWNER, proposal());
  assert.equal(workflows.index(OWNER).lessons, undefined, 'its author reads it as its own workflow');
  assert.deepEqual(workflows.index(OWNER).workflows[0].lesson, { trigger: LESSON.trigger, scope: LESSON.scope });

  const shared = workflows.index(READER);
  assert.deepEqual(shared.workflows, []);
  assert.equal(Object.hasOwn(shared.lessons[0], 'steps'), false, 'the compact index carries no steps');
  assert.deepEqual([shared.lessons[0].workflowId, shared.lessons[0].agentId, shared.lessons[0].lesson],
    [kept.workflow.workflowId, OWNER.agentId, { trigger: LESSON.trigger, scope: LESSON.scope }]);
  const read = workflows.read(READER, { workflowId: kept.workflow.workflowId });
  assert.deepEqual([read.shared, read.agentId, read.lesson, read.steps], [true, OWNER.agentId, LESSON, STEPS]);
  assert.equal(Object.hasOwn(read, 'delivery'), false, 'a peer never sees the private delivery id');
  assert.equal(Object.hasOwn(read, 'approval'), false, 'a peer never sees the person\'s words');
  assert.throws(() => workflows.recordRun(READER, { workflowId: kept.workflow.workflowId, outcome: 'done' }), { code: 'workflow_not_found' });

  assert.deepEqual(workflows.index(OUTSIDE), { workflows: [] }, 'another project sees nothing, not even a count');
  assert.throws(() => workflows.read(OUTSIDE, { workflowId: kept.workflow.workflowId }), { code: 'workflow_not_found' });
});

test('a new FLA\'s first entry names a same-project peer lesson only in the spare workflow slots', (t) => {
  const { workflows } = workflowsIn(t);
  const entryFor = (agentId, personalProjectId = OWNER.personalProjectId, opensConversation = true) => flaGrowthEntry(
    { config: { personal: { spaceId: SPACE } }, agentWorkflows: workflows },
    { projectAgentId: agentId, personalProjectId }, { opensConversation });
  const keep = (owner, name) => {
    const { workflow } = workflows.propose(owner, { name, purpose: `Purpose of ${name}`, steps: STEPS, source: 'agent' });
    workflows.decide({ personalSpaceId: SPACE, workflowId: workflow.workflowId, decision: 'confirm', version: 1 });
    return workflow.workflowId;
  };

  const lesson = workflows.propose(OWNER, proposal());

  // A different FLA in the same project sees the learned technique in its first
  // entry: a small id and a trigger, not the steps or the private delivery.
  const first = entryFor(READER.agentId);
  assert.deepEqual(first.workflows, [{ workflowId: lesson.workflow.workflowId, name: 'Check a release build',
    purpose: LESSON.trigger, shared: true }]);
  assert.equal(Object.hasOwn(first, 'repeated'), false);
  assert.doesNotMatch(JSON.stringify(first), /Run the focused tests|conversation-delivery/);
  assert.deepEqual(workflows.read(READER, { workflowId: first.workflows[0].workflowId }).lesson, LESSON);

  // The owner's own confirmed workflows keep the ceiling: two own leave one
  // spare, a third fills it and the peer lesson no longer appears.
  const own = [keep(READER, 'Own one'), keep(READER, 'Own two')];
  assert.deepEqual(entryFor(READER.agentId).workflows.map(item => [item.name, item.shared ?? false]),
    [['Own one', false], ['Own two', false], ['Check a release build', true]]);
  own.push(keep(READER, 'Own three'));
  const full = entryFor(READER.agentId);
  assert.deepEqual(full.workflows.map(item => item.workflowId), own);
  assert.equal(full.workflows.some(item => item.shared), false);

  // Only the first turn of a conversation, only this project, and not after the
  // lesson is retired.
  assert.equal(entryFor(READER.agentId, OWNER.personalProjectId, false), null, 'a later turn stays quiet');
  assert.equal(entryFor(OUTSIDE.agentId, OUTSIDE.personalProjectId), null, 'another project sees nothing here');
  assert.deepEqual(entryFor('fla-newcomer'), first, 'a brand-new FLA still finds it until the slots are taken');
  workflows.decide({ personalSpaceId: SPACE, workflowId: lesson.workflow.workflowId, decision: 'retire', version: 1 });
  const retired = entryFor('fla-newcomer');
  assert.equal(retired, null, 'a retired lesson is not offered');
});

test('the shared same-project lesson index is bounded and says there is more', (t) => {
  const { workflows } = workflowsIn(t);
  for (let index = 0; index < 21; index += 1) {
    const author = { ...OWNER, agentId: `fla-author-${index}` };
    const kept = workflows.propose(author, proposal({ name: `Lesson ${index}`, source: `lesson:shared-${index}`,
      delivery: { conversationId: `conversation-${index}`, revision: 1 }, approval: approval(author.agentId) }));
    assert.equal(kept.status, 'confirmed');
  }
  const listed = workflows.index(OWNER);
  assert.equal(listed.lessons.length, 20);
  assert.equal(listed.lessonsMore, true);
  assert.equal(workflows.index(OUTSIDE).lessons, undefined);
});

test('the same durable FLA in two projects reaches only its own project\'s lessons; ordinary workflows keep their contract', (t) => {
  const { workflows } = workflowsIn(t);
  const lesson = workflows.propose(OWNER, proposal());
  const ordinary = workflows.propose(OWNER, { name: 'Ordinary steps', purpose: 'Ordinary', steps: STEPS, source: 'agent' });
  const confirmed = workflows.decide({ personalSpaceId: SPACE, workflowId: ordinary.workflow.workflowId,
    decision: 'confirm', version: 1 });
  assert.equal(confirmed.status, 'confirmed');

  // A lesson is the project's: the same FLA elsewhere cannot list, read, change
  // or record a run of it.
  assert.deepEqual(workflows.index(SAME_FLA_ELSEWHERE).workflows.map(item => item.workflowId),
    [ordinary.workflow.workflowId], 'only the ordinary workflow crosses the project boundary');
  assert.throws(() => workflows.read(SAME_FLA_ELSEWHERE, { workflowId: lesson.workflow.workflowId }), { code: 'workflow_not_found' });
  assert.throws(() => workflows.recordRun(SAME_FLA_ELSEWHERE, { workflowId: lesson.workflow.workflowId, outcome: 'done' }),
    { code: 'workflow_not_found' });
  assert.throws(() => workflows.propose(SAME_FLA_ELSEWHERE, proposal({ workflowId: lesson.workflow.workflowId })),
    { code: 'workflow_not_found' });

  // A legacy non-lesson workflow still reads and runs from the other project.
  assert.deepEqual(workflows.read(SAME_FLA_ELSEWHERE, { workflowId: ordinary.workflow.workflowId }).steps, STEPS);
  assert.equal(workflows.recordRun(SAME_FLA_ELSEWHERE, { workflowId: ordinary.workflow.workflowId, outcome: 'done' }).status,
    'recorded');

  // A lesson kept in the other project is a new idea there, not the first one.
  const other = workflows.propose(SAME_FLA_ELSEWHERE, proposal({ name: 'Check a release build elsewhere',
    source: 'lesson:elsewhere', delivery: { conversationId: 'conversation-elsewhere', revision: 1 } }));
  assert.equal(other.status, 'confirmed');
  assert.notEqual(other.workflow.workflowId, lesson.workflow.workflowId);
  assert.deepEqual(workflows.index(READER).lessons.map(item => item.workflowId), [lesson.workflow.workflowId]);
});

// The Agent side: the person's words are checked in the request that began this
// turn, and the completed delivery is resolved from FULI's own scoped record.
const TASK = Object.freeze({ token: 'fuli-task-lesson', sessionId: 'session-a', turnId: 'turn-1',
  personalProjectId: OWNER.personalProjectId, projectAgentId: OWNER.agentId, sourceApplication: 'opencode' });

// The Provider's own contract: a session binding returns only its conversation
// id, and a context read returns the record only to the same space, project and
// FLA (404 otherwise). No fabricated "verified" flag stands in for it.
class Conversations {
  #sessions = new Map();
  #records = new Map();
  open({ session, conversationId, status = 'completed', revision = 1, agentId = OWNER.agentId,
    personalProjectId = OWNER.personalProjectId, sourceApplication = 'opencode', spaceId = SPACE }) {
    this.#sessions.set(`${spaceId}\0${personalProjectId}\0${agentId}\0${sourceApplication}\0${session}`, conversationId);
    this.#records.set(conversationId, { id: conversationId, status, revision, personal_space_id: spaceId,
      personal_project_id: personalProjectId, agent_id: agentId });
    return this;
  }
  async conversation(operation, input) {
    if (operation !== 'query') throw new TypeError(`unexpected conversation operation ${operation}`);
    if (input.mode === 'session') {
      const key = `${input.personal_space_id}\0${input.personal_project_id}\0${input.agent_id}\0${input.source_application}\0${input.session_id}`;
      return { conversation_id: this.#sessions.get(key) ?? null };
    }
    if (input.mode === 'context') {
      const record = this.#records.get(input.conversation_id);
      if (!record || record.personal_space_id !== input.personal_space_id
        || record.personal_project_id !== input.personal_project_id || record.agent_id !== input.agent_id) {
        throw Object.assign(new Error('Conversation not found in this Agent and project'), { status: 404 });
      }
      return { ...record };
    }
    throw new TypeError(`unexpected conversation mode ${input.mode}`);
  }
}

function toolApp(t, task, conversations = new Conversations(), { messages = [] } = {}) {
  const { workflows } = workflowsIn(t);
  const prompts = [];
  const app = {
    config: { personal: { spaceId: SPACE } },
    agentWorkflows: workflows,
    personal: { conversation: (operation, input) => conversations.conversation(operation, input) },
    entryPrompts: { read: current => (current.token === task.token && prompts.length
      ? { prompt: prompts.join('\n'), keptAt: '2026-11-25T00:00:00.000Z' } : null) },
    nativeChoiceAnswers: async () => [],
    recentSessionUserMessages: async () => messages,
    taskContextRegistry: { context: async (token) => {
      if (token !== task.token) throw new TypeError('Unknown task context');
      return task;
    } }
  };
  return { app, workflows, prompts };
}

const keepInput = (overrides = {}) => ({ taskContextToken: TASK.token, name: 'Check a release build',
  purpose: 'Check a synthetic release before it ships', steps: STEPS, personWords: '下次也这样做', lesson: LESSON, ...overrides });

test('invented approval words are refused; the real affirmative words keep the completed delivery', async (t) => {
  const conversations = new Conversations().open({ session: TASK.sessionId, conversationId: 'conversation-delivery' });
  const { app, workflows, prompts } = toolApp(t, TASK, conversations);
  prompts.push('修好它');
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', keepInput()),
    (error) => error.code === 'person_words_not_found');
  assert.deepEqual(workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows, []);

  prompts.push('修好它，下次也这样做');
  const kept = await callAgentTool(app, 'propose_agent_workflow', keepInput());
  assert.equal(kept.status, 'confirmed');
  assert.match(kept.note, /completed delivery/);
  const [view] = workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows;
  assert.deepEqual(view.active.delivery, { conversationId: 'conversation-delivery', revision: 1 });
  const retry = await callAgentTool(app, 'propose_agent_workflow', keepInput());
  assert.equal(retry.status, 'unchanged');
  assert.equal(workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows[0].versionCount, 1);
});

test('unrelated, negative, quoted and example wording is not a reuse instruction', async (t) => {
  const conversations = new Conversations().open({ session: TASK.sessionId, conversationId: 'conversation-delivery' });
  const refused = async (prompt, words) => {
    const { app, workflows, prompts } = toolApp(t, TASK, conversations);
    prompts.push(prompt);
    await assert.rejects(callAgentTool(app, 'propose_agent_workflow', keepInput({ personWords: words })),
      (error) => error.code === 'person_words_not_found');
    assert.deepEqual(workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows, []);
  };
  await refused('谢谢，辛苦了', '谢谢');
  await refused('好的，收到', '好的');
  await refused('下次不这样做', '下次不这样做');
  await refused('不要下次也这样做', '不要下次也这样做');
  await refused('上次说下次也这样做', '上次说下次也这样做');
  await refused('如果我说下次也这样做，你就记下来', '如果我说下次也这样做，你就记下来');
  await refused('比如，下次也这样做', '下次也这样做');
  await refused('举个例子：下次也这样做。请只解释这句话。', '下次也这样做');
  await refused('下次也这样做？', '下次也这样做');
  await refused('下次也这样做，好吗？', '下次也这样做');
  await refused('「下次也这样做」', '「下次也这样做」');
  await refused('for example, do it this way next time', 'do it this way next time');
  await refused('do it this way next time?', 'do it this way next time');
  await refused('do not do it this way next time', 'do not do it this way next time');
});

test('a missing, running or foreign delivery is refused instead of presenting a learned success', async (t) => {
  const unbound = new Conversations();
  const missing = toolApp(t, TASK, unbound);
  missing.prompts.push('下次也这样做');
  await assert.rejects(callAgentTool(missing.app, 'propose_agent_workflow', keepInput()),
    { code: 'delivery_not_completed' });

  const running = new Conversations().open({ session: TASK.sessionId, conversationId: 'conversation-running', status: 'incomplete' });
  const pending = toolApp(t, TASK, running);
  pending.prompts.push('下次也这样做');
  await assert.rejects(callAgentTool(pending.app, 'propose_agent_workflow', keepInput()),
    { code: 'delivery_not_completed' });
  assert.deepEqual(pending.workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows, []);

  // An explicit id is checked against this project and FLA; another project's is a 404.
  const scoped = new Conversations().open({ session: TASK.sessionId, conversationId: 'conversation-delivery' })
    .open({ session: 'session-elsewhere', conversationId: 'conversation-foreign', personalProjectId: 'project-b' });
  const foreign = toolApp(t, TASK, scoped);
  foreign.prompts.push('下次也这样做');
  await assert.rejects(callAgentTool(foreign.app, 'propose_agent_workflow',
    keepInput({ deliveryRef: 'conversation-foreign' })), { code: 'delivery_not_completed' });
});

test('an explicit deliveryRef keeps a completed delivery from another session in this project', async (t) => {
  const conversations = new Conversations()
    .open({ session: TASK.sessionId, conversationId: 'conversation-delivery' })
    .open({ session: 'session-earlier', conversationId: 'conversation-earlier', revision: 9 });
  const { app, workflows, prompts } = toolApp(t, TASK, conversations);
  prompts.push('这次做得对，以后也这样做');
  const kept = await callAgentTool(app, 'propose_agent_workflow', keepInput({ personWords: '以后也这样做',
    deliveryRef: 'conversation-earlier' }));
  assert.equal(kept.status, 'confirmed');
  const [view] = workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows;
  assert.deepEqual(view.active.delivery, { conversationId: 'conversation-earlier', revision: 9 });
});

test('a saved message counts only for this task\'s own turn; another FLA reads the lesson', async (t) => {
  const conversations = new Conversations().open({ session: 'session-a', conversationId: 'conversation-delivery' });
  const saved = (ref) => [{ text: '好的，下次也这样做', ref }];
  const withoutHook = (task, messages) => {
    const built = toolApp(t, task, conversations, { messages });
    built.app.entryPrompts = { read: () => null };
    return built;
  };

  // A previous task's message in the same session, and a task with no turn to
  // compare, prove nothing: the lesson is not kept.
  const stale = withoutHook({ ...TASK, token: 'fuli-task-stale' },
    saved({ taskId: 'prior-task', turnId: 'prior-turn', at: '2026-11-24T10:00:00.000Z' }));
  await assert.rejects(callAgentTool(stale.app, 'propose_agent_workflow',
    keepInput({ taskContextToken: 'fuli-task-stale' })), { code: 'person_words_not_found' });
  assert.deepEqual(stale.workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows, []);

  const unbound = withoutHook({ ...TASK, token: 'fuli-task-unbound', turnId: null },
    saved({ taskId: 'prior-task', at: '2026-11-24T10:00:00.000Z' }));
  await assert.rejects(callAgentTool(unbound.app, 'propose_agent_workflow',
    keepInput({ taskContextToken: 'fuli-task-unbound' })), { code: 'person_words_not_found' });

  // This task's own turn: the saved words are its own.
  const bound = withoutHook({ ...TASK, token: 'fuli-task-transcript' },
    saved({ taskId: 'task-transcript', turnId: TASK.turnId, conversationId: 'conversation-delivery',
      at: '2026-11-25T00:00:00.000Z' }));
  const kept = await callAgentTool(bound.app, 'propose_agent_workflow',
    keepInput({ taskContextToken: 'fuli-task-transcript' }));
  assert.equal(kept.status, 'confirmed');
  const [view] = bound.workflows.overview({ personalSpaceId: SPACE, agentId: OWNER.agentId }).workflows;
  assert.deepEqual(view.active.approval.messageRef, { source: 'session_record', taskId: 'task-transcript',
    conversationId: 'conversation-delivery', at: '2026-11-25T00:00:00.000Z' });

  const reader = toolApp(t, { ...TASK, token: 'fuli-task-reader', projectAgentId: 'fla-reader' });
  reader.app.agentWorkflows = bound.workflows;
  const index = await callAgentTool(reader.app, 'list_agent_workflows', { taskContextToken: 'fuli-task-reader' });
  assert.deepEqual(index.lessons.map(item => [item.workflowId, item.lesson.trigger]),
    [[kept.workflow.workflowId, LESSON.trigger]]);
  const read = await callAgentTool(reader.app, 'read_agent_workflow',
    { taskContextToken: 'fuli-task-reader', workflowId: kept.workflow.workflowId });
  assert.deepEqual([read.shared, read.lesson, read.steps], [true, LESSON, STEPS]);
});

test('a lesson needs a project, the person\'s words and steps; an ordinary proposal still just waits', async (t) => {
  const conversations = new Conversations().open({ session: TASK.sessionId, conversationId: 'conversation-delivery' });
  const unbound = toolApp(t, { ...TASK, token: 'fuli-task-no-project', personalProjectId: null }, conversations);
  unbound.prompts.push('下次也这样做');
  await assert.rejects(callAgentTool(unbound.app, 'propose_agent_workflow', keepInput({ taskContextToken: 'fuli-task-no-project' })),
    { code: 'agent_not_bound' });

  const { app, prompts } = toolApp(t, TASK, conversations);
  prompts.push('下次也这样做');
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', keepInput({ experienceIds: ['k1', 'k2', 'k3'] })),
    /not experienceIds or workMap/);
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', keepInput({ lesson: undefined })),
    /personWords needs lesson/);
  await assert.rejects(callAgentTool(app, 'propose_agent_workflow', keepInput({ personWords: undefined })),
    /lesson needs the person/);

  const ordinary = await callAgentTool(app, 'propose_agent_workflow',
    { taskContextToken: TASK.token, name: 'Ordinary', purpose: 'Ordinary work', steps: STEPS });
  assert.equal(ordinary.status, 'proposed');
});
