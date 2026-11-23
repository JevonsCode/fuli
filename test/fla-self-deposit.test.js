import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createAgentWorkflows } from '../src/agent-workflows/port.js';
import { flaGrowthEntry } from '../src/fla-growth/entry-hint.js';
import { startToolSuggestionScheduler } from '../src/fla-growth/tool-suggestions.js';
import { entryRules } from '../src/conversations/entry-rules.js';
import { listAgentTools } from '../src/agent-tools.js';
import { createRunGate } from '../src/agent-apps/run-gate.js';
import { refuseRemoteDecision } from '../src/http/request-policy.js';

// Jevons 11-23: an FLA that keeps doing a kind of work writes it down as a
// workflow; what it runs every time becomes a script. Synthetic data only.
const SPACE = 'space-synthetic';
const OWNER = { personalSpaceId: SPACE, agentId: 'fla-1', personalProjectId: 'garden' };
const STEPS = [{ title: 'Bump the version' }, { title: 'Build the tray zip' }, { title: 'Upload the release asset' }];
const REPEAT = { key: 'repeat-1', ...OWNER, kind: 'steps', name: 'Bump the version', stepCount: 3, taskCount: 3 };

function workflowsAt(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-self-deposit-'));
  const path = join(directory, 'agent-workflows.sqlite');
  const workflows = createAgentWorkflows({ path });
  t.after(() => { workflows.close(); rmSync(directory, { recursive: true, force: true }); });
  return { workflows, path };
}

const app = workflows => ({ config: { personal: { spaceId: SPACE } }, agentWorkflows: workflows });
const task = { projectAgentId: 'fla-1', personalProjectId: 'garden' };

test('an FLA with nothing repeated and no workflow gets no extra key, and no store file is created', (t) => {
  const { workflows, path } = workflowsAt(t);
  assert.equal(flaGrowthEntry(app(workflows), task, { opensConversation: true }), null);
  assert.throws(() => new DatabaseSync(path, { readOnly: true }));
  // Not an FLA's task, or no project: nothing to say either.
  assert.equal(flaGrowthEntry(app(workflows), { personalProjectId: 'garden' }), null);
  assert.equal(flaGrowthEntry(app(workflows), { projectAgentId: 'fla-1' }), null);
});

test('a repeat reaches that FLA\'s entry in that project at most twice, and stops once it deposits', (t) => {
  const { workflows } = workflowsAt(t);
  workflows.noteRepeat(REPEAT);
  // Another FLA, another project: not theirs.
  assert.equal(flaGrowthEntry(app(workflows), { ...task, projectAgentId: 'fla-2' }), null);
  assert.equal(flaGrowthEntry(app(workflows), { ...task, personalProjectId: 'orchard' }), null);
  const first = flaGrowthEntry(app(workflows), task);
  assert.match(first.repeated, /same 3 steps .* in 3 tasks here/);
  assert.match(first.repeated, /propose_agent_workflow/);
  assert.match(first.repeated, /submit_agent_app_version/);
  // Found again by the next hourly check: the same hint, not a fresh one.
  workflows.noteRepeat({ ...REPEAT, taskCount: 4 });
  assert.match(flaGrowthEntry(app(workflows), task).repeated, /in 4 tasks/);
  assert.equal(flaGrowthEntry(app(workflows), task), null, 'shown twice, then quiet: a reminder, never a nag');

  workflows.noteRepeat({ ...REPEAT, key: 'repeat-2', name: 'Run the smoke test' });
  workflows.propose(OWNER, { name: 'Weekly release', purpose: 'Ship the synthetic tray', steps: STEPS, source: 'agent' });
  assert.equal(flaGrowthEntry(app(workflows), task), null, 'deposited: FULI does not keep asking');
});

test('a proposal is not named as in use; a confirmed workflow is, by name only, on a conversation\'s first turn', (t) => {
  const { workflows } = workflowsAt(t);
  const { workflow } = workflows.propose(OWNER, { name: 'Weekly release', purpose: 'Ship the synthetic tray', steps: STEPS, source: 'agent' });
  assert.equal(flaGrowthEntry(app(workflows), task, { opensConversation: true }), null, 'waiting for the person');
  workflows.decide({ personalSpaceId: SPACE, workflowId: workflow.workflowId, decision: 'confirm', version: 1 });
  assert.deepEqual(flaGrowthEntry(app(workflows), task, { opensConversation: true }),
    { workflows: [{ workflowId: workflow.workflowId, name: 'Weekly release', purpose: 'Ship the synthetic tray' }] });
  // Later turns of the conversation already have it.
  assert.equal(flaGrowthEntry(app(workflows), task), null);
  assert.equal(flaGrowthEntry(app(workflows), { ...task, personalProjectId: 'orchard' }, { opensConversation: true }), null);
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

test('the hourly check notes the repeat for the FLA as well as asking the person', async (t) => {
  const { workflows } = workflowsAt(t);
  const events = [{ eventId: 'e', createdAt: '2026-11-06T00:00:00Z',
    executionPlan: { steps: STEPS.map(step => ({ title: step.title, status: 'completed' })) } }];
  const tasks = ['t1', 't2', 't3'].map(taskId => ({ taskId, title: taskId, status: 'completed', personalProjectId: 'garden',
    leadAgentId: 'fla-1', events }));
  const requests = [];
  const application = { config: { personal: { spaceId: SPACE } }, agentWorkflows: workflows,
    listProjectAgentTasks: async () => { application.ticked = true; return tasks; },
    requestAgentAttention: async input => { requests.push(input); return { requestId: 'r' }; } };
  const stop = startToolSuggestionScheduler({ app: application, intervalMs: 1 });
  for (let waited = 0; waited < 200 && !requests.length; waited++) await delay(5);
  await stop();
  assert.equal(new Set(requests.map(request => request.idempotencyKey)).size, 1, 'one request for the person, as before');
  assert.match(flaGrowthEntry(app(workflows), task).repeated, /same 3 steps \("Bump the version" …\) in 3 tasks here/);
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

test('the task entry carries fla_growth only when there is something to say, and an ordinary entry is unchanged', async (t) => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../src/mcp/provider-task-context-registry.js');
  const { workflows } = workflowsAt(t);
  const application = { config: { personal: { spaceId: SPACE } }, agentWorkflows: workflows, taskContextRegistry: {
    begin: async () => taskRecord({ token: 'fuli-task-synthetic-growth', session_id: 's', personal_project_id: 'garden',
      project_agent_id: 'fla-1', entry_via: 'tool' }) } };
  const preferences = { context: { personal_project_id: 'garden', project_agent_id: 'fla-1' }, effective_preferences: [] };
  const enter = () => beginTaskFromPreferences(application, preferences, { sessionId: 's', taskPrompt: 'Ship the release.' });
  assert.equal('fla_growth' in await enter(), false);
  workflows.noteRepeat(REPEAT);
  const entry = await enter();
  assert.match(entry.fla_growth.repeated, /propose_agent_workflow/);
  assert.ok(JSON.stringify(entry.fla_growth).length < 260, String(JSON.stringify(entry.fla_growth).length));
});
