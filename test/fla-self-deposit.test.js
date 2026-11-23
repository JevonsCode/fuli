import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAgentWorkflows } from '../src/agent-workflows/port.js';
import { appSubmitted, AGENT_WORKFLOW_HANDLERS } from '../src/agent-workflows/agent-tools.js';
import { flaGrowthEntry } from '../src/fla-growth/entry-hint.js';
import { repeatedPlans, suggestRepeatedTools } from '../src/fla-growth/tool-suggestions.js';
import { plansAlike } from '../src/fla-growth/step-similarity.js';
import { entryRules } from '../src/conversations/entry-rules.js';
import { listAgentTools } from '../src/agent-tools.js';
import { createRunGate } from '../src/agent-apps/run-gate.js';
import { refuseRemoteDecision } from '../src/http/request-policy.js';

// Jevons 11-23: an FLA that keeps doing a kind of work writes it down as a
// workflow; what it runs every time becomes a script. Synthetic data only.
const SPACE = 'space-synthetic';
const OWNER = { personalSpaceId: SPACE, agentId: 'fla-1', personalProjectId: 'garden' };
const RELEASE = ['Bump the version', 'Build the tray zip', 'Upload the release asset'];
const STEPS = RELEASE.map(title => ({ title }));
const REPEAT = { key: 'repeat-1', ...OWNER, kind: 'steps', name: 'Bump the version', steps: RELEASE, taskCount: 3 };
const task = { projectAgentId: 'fla-1', personalProjectId: 'garden' };
const opening = { opensConversation: true };

function workflowsAt(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-self-deposit-'));
  const path = join(directory, 'agent-workflows.sqlite');
  const workflows = createAgentWorkflows({ path });
  t.after(() => { workflows.close(); rmSync(directory, { recursive: true, force: true }); });
  return { workflows, path };
}

// The person's 待决策 as the Provider keeps it: one request per key, a changed
// wording under the same key refused (409), answers and cancellations recorded.
function attention() {
  const requests = new Map();
  const calls = [];
  let next = 0;
  const fingerprint = ({ idempotencyKey, ...rest }) => JSON.stringify(rest);
  return { requests, calls,
    async requestAgentAttention(input) {
      calls.push('request');
      const existing = [...requests.values()].find(item => item.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint(input)) throw Object.assign(new Error('attention idempotency key conflict'), { status: 409 });
        return existing;
      }
      const record = { ...input, requestId: `request-${++next}`, status: 'open', revision: 0, fingerprint: fingerprint(input) };
      requests.set(record.requestId, record);
      return record;
    },
    async getAgentAttention({ requestId }) { calls.push('get'); return requests.get(requestId); },
    async cancelAgentAttention({ requestId, expectedRevision }) {
      calls.push('cancel');
      const record = requests.get(requestId);
      assert.equal(record.revision, expectedRevision);
      Object.assign(record, { status: 'cancelled', revision: record.revision + 1 });
      return record;
    },
    async listAgentAttention({ status }) {
      calls.push('list');
      return { items: [...requests.values()].filter(item => item.status === status) };
    },
    answer(requestId, choice) { Object.assign(requests.get(requestId), { status: 'resolved', response: choice, revision: 1 }); }
  };
}

const plan = steps => [{ eventId: 'e', createdAt: '2026-11-06T00:00:00Z',
  executionPlan: { steps: steps.map(title => ({ title, status: 'completed' })) } }];
const finished = (taskId, steps, updatedAt = `2026-11-0${taskId.slice(-1)}T00:00:00Z`) => ({ taskId, title: taskId, status: 'completed',
  personalProjectId: 'garden', leadAgentId: 'fla-1', updatedAt, events: plan(steps) });

function application(workflows, inbox, tasks = []) {
  return { ...inbox, config: { personal: { spaceId: SPACE } }, agentWorkflows: workflows,
    listProjectAgentTasks: async ({ afterTaskId }) => afterTaskId ? [] : tasks,
    taskContextRegistry: { context: async () => ({ projectAgentId: 'fla-1', personalProjectId: 'garden', sourceApplication: 'other' }) } };
}

const app = workflows => ({ config: { personal: { spaceId: SPACE } }, agentWorkflows: workflows });
const propose = (application, input) => AGENT_WORKFLOW_HANDLERS.propose_agent_workflow(application,
  { taskContextToken: 'fuli-task-synthetic', name: 'Weekly release', purpose: 'Ship the synthetic tray. Twice a week.', steps: STEPS, ...input });

test('the same kind of work is found when the Agent words its steps differently each time', () => {
  // How the judge fares on synthetic plans: paraphrased, reordered and one step longer all count.
  const alike = [
    ['Bump the version', 'Build the tray zip', 'Upload the release asset'],
    ['Bump version to 1.4.2', 'Build tray zip', 'Upload release asset to GitHub'],
    ['Build the tray zip', 'Bump the version', 'Upload the release asset', 'Post the release note'],
    ['运行单元测试', '打包托盘程序', '上传发布附件'], ['运行全部单元测试', '打包托盘', '上传发布的附件']
  ];
  assert.equal(plansAlike(alike[0], alike[1]), true);
  assert.equal(plansAlike(alike[0], alike[2]), true);
  assert.equal(plansAlike(alike[3], alike[4]), true);
  // Different work, or too little of it, is not.
  assert.equal(plansAlike(alike[0], ['Read the bug report', 'Reproduce the crash', 'Write a regression test']), false);
  assert.equal(plansAlike(alike[0], ['Bump the version', 'Build the tray zip']), false);
  assert.equal(plansAlike(alike[0], ['Bump the version', 'Write the design doc', 'Review the API names']), false);

  const groups = repeatedPlans([finished('t1', alike[0]), finished('t2', alike[1]), finished('t3', alike[2]),
    finished('t4', ['Read the bug report', 'Reproduce the crash', 'Write a regression test'])]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tasks.map(item => item.taskId), ['t1', 't2', 't3']);
  // The oldest task stands for the group, so a later one does not change its key.
  assert.equal(repeatedPlans([finished('t1', alike[0]), finished('t2', alike[1]), finished('t3', alike[2]),
    finished('t5', alike[1])])[0].key, groups[0].key);
});

test('an FLA with nothing repeated and no workflow gets no extra key, and no store file is created', (t) => {
  const { workflows, path } = workflowsAt(t);
  assert.equal(flaGrowthEntry(app(workflows), task, opening), null);
  assert.throws(() => new DatabaseSync(path, { readOnly: true }));
  assert.equal(flaGrowthEntry(app(workflows), { personalProjectId: 'garden' }, opening), null);
  assert.equal(flaGrowthEntry(app(workflows), { projectAgentId: 'fla-1' }, opening), null);
});

test('a repeat reaches that FLA only on the first turn of a conversation, at most twice', (t) => {
  const { workflows } = workflowsAt(t);
  workflows.noteRepeat(REPEAT);
  // Later turns of a conversation cannot use the reminders up.
  for (let turn = 0; turn < 5; turn += 1) assert.equal(flaGrowthEntry(app(workflows), task), null);
  assert.equal(flaGrowthEntry(app(workflows), { ...task, projectAgentId: 'fla-2' }, opening), null);
  assert.equal(flaGrowthEntry(app(workflows), { ...task, personalProjectId: 'orchard' }, opening), null);
  const first = flaGrowthEntry(app(workflows), task, opening);
  assert.match(first.repeated, /same kind of work, "Bump the version" \(3 tasks here\)/);
  assert.match(first.repeated, /propose_agent_workflow/);
  workflows.noteRepeat({ ...REPEAT, taskCount: 4 });
  assert.match(flaGrowthEntry(app(workflows), task, opening).repeated, /\(4 tasks here\)/);
  assert.equal(flaGrowthEntry(app(workflows), task, opening), null, 'shown in two conversations, then quiet');
});

test('only a proposal of the same work deposits a repeat; a rejected one gives it back', async (t) => {
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const application_ = application(workflows, inbox);
  workflows.noteRepeat(REPEAT);
  const unrelated = await propose(application_, { name: 'Bug triage', purpose: 'Triage a bug.',
    steps: [{ title: 'Read the bug report' }, { title: 'Reproduce the crash' }, { title: 'Write a regression test' }] });
  assert.equal(unrelated.status, 'proposed');
  assert.match(flaGrowthEntry(app(workflows), task, opening).repeated, /Bump the version/, 'an unrelated workflow deposits nothing');
  const release = await propose(application_, { steps: ['Bump version', 'Build tray zip', 'Upload release asset'].map(title => ({ title })) });
  assert.equal(release.status, 'proposed');
  assert.equal(flaGrowthEntry(app(workflows), task, opening), null);
  workflows.decide({ personalSpaceId: SPACE, workflowId: release.workflow.workflowId, decision: 'reject', version: 1 });
  workflows.noteRepeat({ ...REPEAT, taskCount: 5 });
  assert.match(flaGrowthEntry(app(workflows), task, opening)?.repeated ?? '', /5 tasks here/, 'turned down: owed again');
});

test('the person is asked once; no Provider call while the same request stands', async (t) => {
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const tasks = ['t1', 't2', 't3'].map(id => finished(id, RELEASE));
  const application_ = application(workflows, inbox, tasks);
  await suggestRepeatedTools(application_);
  assert.equal([...inbox.requests.values()].length, 1);
  const [request] = inbox.requests.values();
  assert.deepEqual(request.options, ['只记下这串步骤', '做成能跑的脚本', '不用']);
  inbox.calls.length = 0;
  await suggestRepeatedTools(application_, { legacyCleared: true });
  assert.deepEqual(inbox.calls.filter(call => call !== 'list'), [], 'nothing asked again');
});

test('the FLA proposing the steps withdraws the open request: the person is asked once, on its page', async (t) => {
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
  await suggestRepeatedTools(application_);
  const [request] = inbox.requests.values();
  const proposed = await propose(application_);
  assert.equal(proposed.status, 'proposed');
  assert.equal(request.status, 'cancelled');
});

test('a person who chose 「只记下这串步骤」 is not asked to confirm again', async (t) => {
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
  await suggestRepeatedTools(application_);
  const [request] = inbox.requests.values();
  inbox.answer(request.requestId, '只记下这串步骤');
  await suggestRepeatedTools(application_, { legacyCleared: true });
  // The FLA hears the decision in its next conversation, with what to call.
  assert.match(flaGrowthEntry(app(workflows), task, opening).repeated,
    /The person chose to keep .* as steps: propose these titles .* propose_agent_workflow .*\["Bump the version","Build the tray zip","Upload the release asset"\]/);
  const proposed = await propose(application_);
  assert.deepEqual([proposed.status, proposed.confirmedBy, proposed.workflow.status], ['active', 'person_choice', 'active']);
  assert.match(proposed.note, /按你在待决策里的选择确认/);
  assert.equal(request.status, 'resolved', 'the answered request is the person\'s and stays as it is');
  assert.deepEqual(flaGrowthEntry(app(workflows), task, opening).workflows.map(item => item.name), ['Weekly release']);
});

test('「只记下这串步骤」 confirms only those steps one for one: two more, one changed or reordered waits for the person', async (t) => {
  const variants = {
    'two more steps': [...RELEASE, 'Push the synthetic tag', 'Deploy to production'],
    'one step changed': ['Bump the version', 'Skip the tray zip', 'Upload the release asset'],
    'another order': ['Build the tray zip', 'Bump the version', 'Upload the release asset']
  };
  for (const [label, titles] of Object.entries(variants)) {
    const { workflows } = workflowsAt(t);
    const inbox = attention();
    const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
    await suggestRepeatedTools(application_);
    const [request] = inbox.requests.values();
    inbox.answer(request.requestId, '只记下这串步骤');
    await suggestRepeatedTools(application_, { legacyCleared: true });
    const proposed = await propose(application_, { steps: titles.map(title => ({ title })) });
    assert.deepEqual([proposed.status, proposed.workflow.status, 'confirmedBy' in proposed], ['proposed', 'proposed', false], label);
    assert.match(proposed.note, /Not confirmed .*not exactly the ones they chose/, label);
    assert.equal(workflows.overview({ personalSpaceId: SPACE, agentId: 'fla-1' }).workflows[0].active, null, label);
  }
  // Spacing and letter case are the same steps.
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
  await suggestRepeatedTools(application_);
  inbox.answer([...inbox.requests.values()][0].requestId, '只记下这串步骤');
  await suggestRepeatedTools(application_, { legacyCleared: true });
  const same = await propose(application_, { steps: RELEASE.map(title => ({ title: `  ${title.toUpperCase()} ` })) });
  assert.equal(same.confirmedBy, 'person_choice');
});

test('「只记下这串步骤」 never replaces a confirmed workflow: the change waits for the person on its page', async (t) => {
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
  const earlier = [{ title: 'Read the synthetic changelog' }, { title: 'Tag the synthetic build' }];
  const { workflow } = workflows.propose(OWNER, { name: 'Weekly release', purpose: 'Ship', steps: earlier, source: 'agent' });
  workflows.decide({ personalSpaceId: SPACE, workflowId: workflow.workflowId, decision: 'confirm', version: 1 });
  await suggestRepeatedTools(application_);
  const [request] = inbox.requests.values();
  inbox.answer(request.requestId, '只记下这串步骤');
  await suggestRepeatedTools(application_, { legacyCleared: true });
  const proposed = await propose(application_, { workflowId: workflow.workflowId });
  assert.deepEqual([proposed.status, proposed.workflow.status, 'confirmedBy' in proposed], ['proposed', 'active', false]);
  assert.match(proposed.note, /Not confirmed .*changes an existing workflow/);
  assert.deepEqual(workflows.read(OWNER, { workflowId: workflow.workflowId }), { workflowId: workflow.workflowId, version: 1,
    name: 'Weekly release', purpose: 'Ship', steps: earlier }, 'the confirmed version is still the one in use');
  const shown = workflows.overview({ personalSpaceId: SPACE, agentId: 'fla-1' }).workflows[0];
  assert.deepEqual([shown.active.version, shown.pending.version], [1, 2], 'the page shows the old steps next to the new');
});

test('a person who chose a script: the FLA is told to submit an Agent app, and submitting it settles the repeat', async (t) => {
  const { workflows, path } = workflowsAt(t);
  const depositedBy = () => { const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare('SELECT deposited_by FROM agent_growth_hints').all().map(row => row.deposited_by); } finally { db.close(); } };
  const inbox = attention();
  const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
  await suggestRepeatedTools(application_);
  const [request] = inbox.requests.values();
  inbox.answer(request.requestId, '做成能跑的脚本\n\n用 bash');
  await suggestRepeatedTools(application_, { legacyCleared: true });
  assert.match(flaGrowthEntry(app(workflows), task, opening).repeated,
    /The person chose a script .* submit_agent_app_version .* confirm it in the terminal from Agents → Apps/);
  // Whose repeat it settles is the submitting task's FLA and project (callingAppOwner).
  await appSubmitted(application_, { ...OWNER, personalProjectId: 'orchard' }, { appId: 'app-orchard', status: 'pending' });
  await appSubmitted(application_, { ...OWNER, agentId: 'fla-2' }, { appId: 'app-other', status: 'pending' });
  assert.deepEqual(depositedBy(), [null], 'another project, another FLA: still owed');
  await appSubmitted(application_, OWNER, { appId: 'app-synthetic', status: 'pending' });
  assert.deepEqual(depositedBy(), ['app:app-synthetic']);
});

test('a request asked in other words is withdrawn before the new one, and an answered one is left alone', async (t) => {
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
  // The 0.29 beta wording, still open, and the same one answered elsewhere.
  const beta = await inbox.requestAgentAttention({ idempotencyKey: 'tool-suggestion:beta-open', title: '「Bump the version」这串步骤已重复 3 次以上，要做成工具吗？',
    options: ['做成脚本', '做成 Agent App', '不用'] });
  const answered = await inbox.requestAgentAttention({ idempotencyKey: 'tool-suggestion:beta-done', title: '「Other」这串步骤已重复 3 次以上，要做成工具吗？',
    options: ['做成脚本', '做成 Agent App', '不用'] });
  inbox.answer(answered.requestId, '做成脚本');
  await suggestRepeatedTools(application_);
  assert.equal(beta.status, 'cancelled');
  assert.equal(answered.status, 'resolved');
  // A later change of wording: the request stored for the repeat (asked in other words) goes first,
  // then the request in the current words is made.
  const key = repeatedPlans(['t1', 't2', 't3'].map(id => finished(id, RELEASE)))[0].key;
  const earlier = await inbox.requestAgentAttention({ idempotencyKey: `tool-suggestion:${key}:earlier`, title: 'earlier words' });
  for (const item of inbox.requests.values()) if (item.idempotencyKey.startsWith(`tool-suggestion:${key}:`) && item !== earlier) inbox.requests.delete(item.requestId);
  workflows.repeatRequested(key, earlier.requestId, 'earlier');
  await suggestRepeatedTools(application_, { legacyCleared: true });
  assert.equal(earlier.status, 'cancelled');
  const open = [...inbox.requests.values()].filter(item => item.status === 'open');
  assert.equal(open.length, 1);
  assert.notEqual(open[0].requestId, earlier.requestId);
});

test('a person who just answered a request in earlier words is not asked again in the new ones', async (t) => {
  for (const reply of ['只记下这串步骤', '我自己写个脚本就行']) {
    const { workflows } = workflowsAt(t);
    const inbox = attention();
    const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
    await suggestRepeatedTools(application_);
    const [request] = inbox.requests.values();
    const key = repeatedPlans(['t1', 't2', 't3'].map(id => finished(id, RELEASE)))[0].key;
    workflows.repeatRequested(key, request.requestId, 'earlier');
    inbox.answer(request.requestId, reply);
    await suggestRepeatedTools(application_, { legacyCleared: true });
    assert.equal(inbox.requests.size, 1, reply);
  }
});

test('an answer the person gave to the 0.29 beta question is kept, not asked again', async (t) => {
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const application_ = application(workflows, inbox, ['t1', 't2', 't3'].map(id => finished(id, RELEASE)));
  const beta = await inbox.requestAgentAttention({ idempotencyKey: 'tool-suggestion:beta', agentId: 'fla-1', personalProjectId: 'garden',
    title: '「Bump the version」这串步骤已重复 3 次以上，要做成工具吗？', detail: ['同样的 3 步，在 3 个以上任务里一模一样：',
      ...RELEASE.map((title, index) => `${index + 1}. ${title}`)].join('\n'), options: ['做成脚本', '做成 Agent App', '不用'] });
  inbox.answer(beta.requestId, '做成脚本');
  await suggestRepeatedTools(application_);
  assert.equal(inbox.requests.size, 1, 'nothing asked in the new words');
  assert.match(flaGrowthEntry(app(workflows), task, opening).repeated, /The person chose a script/);
});

test('an answer to the 0.29 beta question settles one repeat only, also after a restart', async (t) => {
  const listed = ['Bump the version', 'Build the tray zip', 'Upload the release asset', 'Announce in the channel', 'Close the milestone'];
  const first = ['t1', 't2', 't3'].map(id => finished(id, listed.slice(0, 3)));
  const second = ['t4', 't5', 't6'].map(id => finished(id, listed.slice(2)));
  const { workflows } = workflowsAt(t);
  const inbox = attention();
  const beta = await inbox.requestAgentAttention({ idempotencyKey: 'tool-suggestion:beta', agentId: 'fla-1', personalProjectId: 'garden',
    title: '「Bump the version」这串步骤已重复 3 次以上，要做成工具吗？', detail: ['同样的 5 步：',
      ...listed.map((title, index) => `${index + 1}. ${title}`)].join('\n'), options: ['做成脚本', '做成 Agent App', '不用'] });
  inbox.answer(beta.requestId, '做成脚本');
  // Both repeats are like the steps the beta request listed; the answer goes to the first.
  await suggestRepeatedTools(application(workflows, inbox, [...first, ...second]));
  assert.equal([...inbox.requests.values()].filter(item => item.status === 'open').length, 1, 'the second is asked');
  // After a restart (fresh state) a repeat found later does not take it either.
  const { workflows: later } = workflowsAt(t);
  const laterInbox = attention();
  const again = await laterInbox.requestAgentAttention({ ...beta, idempotencyKey: 'tool-suggestion:beta' });
  laterInbox.answer(again.requestId, '做成脚本');
  await suggestRepeatedTools(application(later, laterInbox, first));
  assert.equal(laterInbox.requests.size, 1, 'the first takes the answer');
  await suggestRepeatedTools(application(later, laterInbox, [...first, ...second]));
  assert.equal([...laterInbox.requests.values()].filter(item => item.status === 'open').length, 1, 'the second is asked');
});

test('a confirmed workflow is named on a conversation\'s first turn by name and one sentence; a proposal is not', (t) => {
  const { workflows } = workflowsAt(t);
  const { workflow } = workflows.propose(OWNER, { name: 'Weekly release', purpose: 'Ship the synthetic tray. Twice a week.', steps: STEPS, source: 'agent' });
  assert.equal(flaGrowthEntry(app(workflows), task, opening), null, 'waiting for the person');
  workflows.decide({ personalSpaceId: SPACE, workflowId: workflow.workflowId, decision: 'confirm', version: 1 });
  assert.deepEqual(flaGrowthEntry(app(workflows), task, opening),
    { workflows: [{ workflowId: workflow.workflowId, name: 'Weekly release', purpose: 'Ship the synthetic tray.' }] });
  assert.equal(flaGrowthEntry(app(workflows), task), null, 'later turns already have it');
  // Its size at the most: three workflows with the longest names and purposes the store takes.
  for (let i = 0; i < 3; i += 1) {
    const { workflow: long } = workflows.propose(OWNER, { name: 'N'.repeat(80), purpose: 'P'.repeat(300), steps: STEPS, source: `agent-${i}` });
    workflows.decide({ personalSpaceId: SPACE, workflowId: long.workflowId, decision: 'confirm', version: 1 });
  }
  const largest = JSON.stringify({ fla_growth: flaGrowthEntry(app(workflows), task, opening) }).length;
  assert.ok(largest <= 900, String(largest));
});

test('an entry never runs a format step: a store the upgrade has not migrated reads as nothing', (t) => {
  const { workflows, path } = workflowsAt(t);
  workflows.noteRepeat(REPEAT);
  workflows.close();
  const older = new DatabaseSync(path);
  older.exec('PRAGMA user_version = 2');
  older.close();
  const reopened = createAgentWorkflows({ path });
  t.after(() => reopened.close());
  assert.equal(flaGrowthEntry(app(reopened), task, opening), null);
  const probe = new DatabaseSync(path, { readOnly: true });
  assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 2, 'left for the hourly check or the console');
  probe.close();
});

test('the console counts every run and every run that went through; a workflow never run shows none', (t) => {
  const { workflows } = workflowsAt(t);
  const { workflow } = workflows.propose(OWNER, { name: 'Weekly release', purpose: 'Ship', steps: STEPS, source: 'agent' });
  const shown = () => workflows.overview({ personalSpaceId: SPACE, agentId: 'fla-1' }).workflows[0];
  assert.deepEqual([shown().runCount, shown().doneCount], [0, 0]);
  workflows.decide({ personalSpaceId: SPACE, workflowId: workflow.workflowId, decision: 'confirm', version: 1 });
  for (let i = 0; i < 7; i += 1) {
    workflows.recordRun(OWNER, { workflowId: workflow.workflowId, taskId: `t${i}`, outcome: i === 3 ? 'stopped' : 'done',
      note: i === 3 ? 'The release channel was frozen' : undefined });
  }
  assert.deepEqual([shown().runCount, shown().doneCount, shown().recentRuns.length], [7, 6, 5]);
});

test('the rule says how to use, record and deposit, and what a script may never do', () => {
  const rule = entryRules().sections.task_guidance.self_deposit;
  for (const words of ['read_agent_workflow', 'record_agent_workflow_run', 'stopped or failed with the reason',
    'propose_agent_workflow', 'submit_agent_app_version', 'no keys or tokens', 'not in use until confirmed',
    'confirm it in the terminal', 'Never run a script another FLA or computer submitted']) assert.ok(rule.includes(words), words);
});

// The script boundary a deposited script lives inside (rec#7): refusal paths.
test('no Agent tool approves, runs or rolls back a script; only the person at this computer does', () => {
  const names = listAgentTools().map(tool => tool.name);
  assert.ok(names.includes('submit_agent_app_version'));
  for (const name of names) assert.doesNotMatch(name, /^(?:approve|run|rollback|start)_agent_app|agent_app_(?:approve|run|rollback)/, name);
});

test('a script the person has not confirmed in the terminal is refused at every start', () => {
  const gate = approval => createRunGate({ store: { existingApp: () => ({ status: 'active', activeVersion: '1.0.0' }),
    approval: () => approval } }).runGate({ appId: 'app-synthetic' });
  assert.equal(gate(null).reason, 'confirmation_required');
  // Clicked in the console (or relayed by an Agent): recorded, never a terminal confirmation.
  assert.equal(gate({ challengeId: null, verifiedAt: null, verification: 'console' }).reason, 'confirmation_required');
  assert.equal(gate({ challengeId: 'c', verifiedAt: '2026-11-01T00:00:00Z', verification: 'hello', trustMode: 'isolated' }).reason,
    'reconfirmation_required');
});

test('a decision that arrives from another computer, or through a relay, is refused', () => {
  const answer = () => { const sent = {}; return { sent, response: { writeHead(status) { sent.status = status; }, setHeader() {},
    end(body) { sent.body = body; } } }; };
  for (const request of [{ socket: { remoteAddress: '192.0.2.10' }, headers: {} },
    { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.10' } }]) {
    const { sent, response } = answer();
    assert.equal(refuseRemoteDecision(request, response, 'Scripts are confirmed only on this computer', { directHost: true }), true);
    assert.equal(sent.status, 403);
  }
  const { response } = answer();
  assert.equal(refuseRemoteDecision({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, response, 'x', { directHost: true }), false);
});

test('the task entry carries fla_growth on a conversation\'s first turn only, and an ordinary entry is unchanged', async (t) => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const { workflows } = workflowsAt(t);
  let recovered = null;
  const application_ = { config: { personal: { spaceId: SPACE } }, agentWorkflows: workflows, getCapturePolicy: () => ({ enabled: true }),
    personal: { conversation: async () => ({ status: 'saved', conversation_id: 'conversation-synthetic', revision: 1,
      recovered_from: recovered, previous: null, recent: null }) },
    taskContextRegistry: { begin: async () => taskRecord({ token: 'fuli-task-synthetic-growth', session_id: 's',
      personal_project_id: 'garden', project_agent_id: 'fla-1', entry_via: 'tool' }) } };
  const preferences = { context: { personal_project_id: 'garden', project_agent_id: 'fla-1' }, effective_preferences: [] };
  const enter = () => beginTaskFromPreferences(application_, preferences, { sessionId: 's', taskPrompt: 'Ship the release.' });
  assert.equal('fla_growth' in await enter(), false);
  workflows.noteRepeat(REPEAT);
  recovered = 'conversation-synthetic';
  assert.equal('fla_growth' in await enter(), false, 'a later turn of the same conversation');
  recovered = null;
  const entry = await enter();
  assert.match(entry.fla_growth.repeated, /propose_agent_workflow/);
  assert.ok(JSON.stringify({ fla_growth: entry.fla_growth }).length < 280, String(JSON.stringify(entry.fla_growth).length));
});
