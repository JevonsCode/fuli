import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { registerStandingAssignment } from '../src/graphiti/standing-assignment-entry.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';

// rec#29 F2: the person's "from now on, this work goes to that project",
// previewed, asked once and confirmed. Synthetic Provider boundary and a
// temporary store only; no real data, client or model.

const SPACE = 'space-synthetic';
const TOKEN = 'fuli-task-synthetic';

function application(t, { activityOrigin = null, delegated = false, projects = [], leads = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-standing-entry-'));
  const path = join(directory, 'standing-assignments.sqlite');
  const standingAssignments = createStandingAssignments({ path });
  t.after(() => { standingAssignments.close(); rmSync(directory, { recursive: true, force: true }); });
  const registered = new Map(projects.map(project => [project.project_id, project]));
  const policy = new Map(Object.entries(leads));
  const calls = [];
  const app = {
    config: { personal: { spaceId: SPACE } }, standingAssignments, calls, path,
    taskContextRegistry: { context: async (token, client) => {
      calls.push(['task', token, client]);
      if (token !== TOKEN) throw Object.assign(new Error('Unknown task context'), { status: 404 });
      return { token, sessionId: 'session-synthetic', activityOrigin };
    } },
    roundtable: { taskEntryDelegation: () => (delegated ? { token: 'delegation' } : null) },
    upsertPersonalProject: async input => {
      calls.push(['create', input]);
      registered.set(input.projectId, { project_id: input.projectId, scope_type: 'registered', profile: input.profile });
    },
    personal: {
      listPersonalProjects: async () => [...registered.values()],
      getPersonalProject: async (_, id) => registered.get(id),
      getProjectAgentCoordinationPolicy: async (_, id) => ({ team_lead_agent_id: policy.get(id) ?? null }),
      getProjectAgent: async (_, __, agentId) => ({ agent_id: agentId, profile: { name: `${agentId} name` } }),
      staffDefaultProjectLead: async input => {
        calls.push(['staff', input]);
        const agentId = `lead-${input.personal_project_id}`;
        policy.set(input.personal_project_id, agentId);
        return { status: 'ready', agent: { agent_id: agentId } };
      }
    }
  };
  app.registerStandingAssignment = input => registerStandingAssignment(app, input);
  return app;
}

const timesheet = (overrides = {}) => ({ taskContextToken: TOKEN, projectName: 'Timesheet', terms: ['iDev', '工时'],
  responsibility: 'Fill the synthetic iDev timesheet', userWords: '以后填 iDev 工时都交给 Timesheet 项目', ...overrides });

const call = (app, action, input) => callAgentTool(app, 'register_standing_assignment', { action, ...input });
const writes = app => app.calls.filter(([kind]) => kind === 'create' || kind === 'staff').map(([kind]) => kind);

test('preview restates the plan in one sentence and writes nothing', async (t) => {
  const app = application(t);
  const preview = await call(app, 'preview', timesheet());
  assert.equal(preview.status, 'preview');
  assert.equal(preview.executed, false);
  assert.equal(preview.restatement, 'FULI will create project "Timesheet", have AR hire its lead for "Fill the '
    + 'synthetic iDev timesheet", and send later tasks that mention "iDev", "工时" there; nothing is done now.');
  assert.match(preview.confirmationDigest, /^[0-9a-f]{64}$/);
  assert.match(preview.guidance, /Nothing was saved\. Ask the user once/);
  assert.deepEqual(writes(app), []);
  assert.equal(existsSync(app.path), false, 'a preview never creates the store');
});

test('confirm creates the project, has AR hire its lead with the responsibility, and registers the terms', async (t) => {
  const app = application(t);
  const { confirmationDigest } = await call(app, 'preview', timesheet());
  const done = await call(app, 'confirm', { ...timesheet(), confirmationDigest });
  assert.equal(done.status, 'registered');
  assert.equal(done.executed, false);
  assert.match(done.notice, /Registered and assigned, NOT executed/);
  assert.deepEqual(done.project, { projectId: 'timesheet', name: 'Timesheet', created: true });
  assert.deepEqual(done.lead, { agentId: 'lead-timesheet', hired: true });
  assert.equal(app.calls.find(([kind]) => kind === 'create')[1].createOnly, true);
  assert.deepEqual(app.calls.find(([kind]) => kind === 'staff')[1], { personal_space_id: SPACE,
    personal_project_id: 'timesheet', source_application: 'other', responsibility: 'Fill the synthetic iDev timesheet' });
  assert.equal(done.assignment.source, 'user');
  assert.equal(done.assignment.sourceConversationId, 'session-synthetic');
  assert.deepEqual(app.standingAssignments.match(SPACE, '帮我填一下今天的工时').map(({ assignment }) =>
    [assignment.projectId, assignment.leadAgentId]), [['timesheet', 'lead-timesheet']]);
});

test('confirming the same plan again creates no second project or hire and leaves the assignment as it was', async (t) => {
  const app = application(t);
  const { confirmationDigest } = await call(app, 'preview', timesheet());
  const first = await call(app, 'confirm', { ...timesheet(), confirmationDigest });
  const again = await call(app, 'confirm', { ...timesheet(), confirmationDigest });
  assert.equal(again.status, 'unchanged');
  assert.equal(again.executed, false);
  assert.deepEqual(writes(app), ['create', 'staff']);
  assert.deepEqual(app.standingAssignments.list(SPACE), [first.assignment]);
  assert.equal(app.standingAssignments.history(first.assignment.assignmentId).length, 1);
  assert.equal((await call(app, 'preview', timesheet())).status, 'already_registered');
});

test('a stale or foreign digest is refused before anything is written', async (t) => {
  const app = application(t);
  const { confirmationDigest } = await call(app, 'preview', timesheet());
  await assert.rejects(call(app, 'confirm', { ...timesheet({ terms: ['iDev'] }), confirmationDigest }),
    { code: 'standing_assignment_plan_changed' });
  // The project appears after the preview: the plan to create it is stale.
  await app.upsertPersonalProject({ projectId: 'timesheet', profile: { name: 'Timesheet' } });
  await assert.rejects(call(app, 'confirm', { ...timesheet(), confirmationDigest }),
    { code: 'standing_assignment_plan_changed' });
  await assert.rejects(call(app, 'confirm', timesheet()), /confirmationDigest is required/);
  assert.deepEqual(writes(app), ['create']);
  assert.equal(existsSync(app.path), false);
});

test('an existing project and lead are reused and named in the restatement', async (t) => {
  const app = application(t, { projects: [{ project_id: 'ops', scope_type: 'registered', profile: { name: 'Ops' } }],
    leads: { ops: 'lead-ops' } });
  const preview = await call(app, 'preview', timesheet({ projectName: 'ops', terms: ['部署'] }));
  assert.match(preview.restatement, /^FULI will reuse project "ops", keep its lead "lead-ops name" for/);
  const done = await call(app, 'confirm', { ...timesheet({ projectName: 'ops', terms: ['部署'] }),
    confirmationDigest: preview.confirmationDigest });
  assert.deepEqual([done.project.created, done.lead.hired, done.assignment.projectId], [false, false, 'ops']);
  assert.deepEqual(writes(app), []);
});

test('a term that already names another project is refused with that project named', async (t) => {
  const app = application(t, { projects: [{ project_id: 'ops', scope_type: 'registered', profile: { name: 'Ops' } }],
    leads: { ops: 'lead-ops' } });
  app.standingAssignments.register({ personalSpaceId: SPACE, projectId: 'ops', leadAgentId: 'lead-ops', terms: ['iDev'],
    responsibility: 'Synthetic ops work', source: 'user' });
  await assert.rejects(call(app, 'preview', timesheet()),
    { code: 'standing_assignment_term_taken', message: /"iDev" already names the standing assignment of project ops/ });
  assert.deepEqual(writes(app), []);
});

test('a one-off request, internal Agent activity and an ambiguous name are refused without writing', async (t) => {
  const app = application(t);
  await assert.rejects(call(app, 'preview', timesheet({ userWords: '这次帮我填一下今天的 iDev 工时' })),
    { code: 'standing_assignment_one_off' });
  for (const options of [{ delegated: true },
    { activityOrigin: { version: 1, kind: 'ai_internal', source: 'roundtable_delegation', purpose: 'delegated_work' } }]) {
    const internal = application(t, options);
    await assert.rejects(call(internal, 'preview', timesheet()), { code: 'standing_assignment_internal_activity' });
    assert.deepEqual(writes(internal), []);
  }
  const twins = application(t, { projects: [
    { project_id: 'timesheet', scope_type: 'registered', profile: { name: 'Timesheet' } },
    { project_id: 'timesheet-2', scope_type: 'registered', profile: { name: 'timesheet' } }] });
  await assert.rejects(call(twins, 'preview', timesheet()), { code: 'standing_assignment_project_ambiguous' });
  assert.deepEqual(writes(app), []);
});
