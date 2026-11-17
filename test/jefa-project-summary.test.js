import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEmployeeFixture } from '../test-support/employee-fixture.js';

// Jefa's cross-project progress summary: one on-demand read of every project she
// manages. Synthetic FULI directories only; the built-in board is real.
const HOME = 'employee-qa';
const DESIGN = 'employee-qa-design';
const RESEARCH = 'employee-qa-research';

async function jefa(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-jefa-summary-'));
  const app = createEmployeeFixture({ runtimeConfigPath: join(root, 'host/graph-runtime.json') });
  // The store closes before its directory goes (Windows locks open files).
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const hired = await app.employees.recruit({ templateId: 'jefa' });
  const call = (tool, args, personalProjectId = HOME) =>
    app.employees.callTool({ templateId: 'jefa', personalProjectId, tool, arguments: args });
  const seed = (project, tasks) => call('create_tasks', { messageId: `seed-${project}-${tasks.length}-${tasks[0].title}`, tasks }, project);
  return { app, call, seed, hired };
}

test('the summary counts every project Jefa manages, and says which ones need the person', async (t) => {
  const { call, seed } = await jefa(t);
  await seed(HOME, [{ title: 'Synthetic home active', status: 'active' }, { title: 'Synthetic home blocked', status: 'blocked', priority: 'high' },
    { title: 'Synthetic home review', status: 'review' }]);
  await seed(DESIGN, [{ title: 'Synthetic design first' }, { title: 'Synthetic design second' }]);

  const { projects, truncated } = await call('summarize_projects', {});
  assert.equal(truncated, false);
  assert.deepEqual(projects.map((project) => project.id).sort(), [HOME, DESIGN, RESEARCH], 'the archived project is not listed');
  const home = projects.find((project) => project.id === HOME);
  assert.equal(home.name, '员工招募验收（测试）');
  assert.deepEqual(home.counts, { planned: 0, active: 1, blocked: 1, review: 1, done: 0 });
  assert.equal(home.total, 3);
  assert.deepEqual(home.blocked.map((task) => task.title), ['Synthetic home blocked']);
  assert.deepEqual(home.awaitingAcceptance.map((task) => task.title), ['Synthetic home review']);
  assert.deepEqual(Object.keys(home.blocked[0]).sort(), ['id', 'priority', 'status', 'title', 'updatedAt'], 'a task is named, not copied');
  assert.ok(home.lastChangedAt);

  const design = projects.find((project) => project.id === DESIGN);
  assert.deepEqual(design.counts, { planned: 2, active: 0, blocked: 0, review: 0, done: 0 });
  assert.deepEqual([design.blocked, design.awaitingAcceptance], [[], []]);
  const research = projects.find((project) => project.id === RESEARCH);
  assert.equal(research.total, 0, 'a project with no tasks is still listed');
  assert.equal(research.lastChangedAt, null);

  assert.equal(projects[0].id, HOME, 'a project with something stuck or waiting comes first');
});

test('the summary reads the same from any project and never writes', async (t) => {
  const { call, seed } = await jefa(t);
  await seed(HOME, [{ title: 'Synthetic home blocked', status: 'blocked' }]);
  const before = await call('read_board', {});
  const fromHome = await call('summarize_projects', {});
  const fromDesign = await call('summarize_projects', {}, DESIGN);
  const strip = ({ collaboration_receipt: _receipt, ...rest }) => rest;
  assert.deepEqual(strip(fromDesign), strip(fromHome));
  assert.deepEqual(await call('read_board', {}), before, 'the board version did not move');
});

test('a project the person excluded from Jefa is not in the summary, and cannot ask for it', async (t) => {
  const { app, call, seed, hired } = await jefa(t);
  await seed(RESEARCH, [{ title: 'Synthetic research blocked', status: 'blocked' }]);
  await app.employees.recruit({ templateId: 'jefa', management: { mode: 'all', excludedProjectIds: [RESEARCH], titleMode: 'auto' },
    replaceAssignments: true, expectedAssignmentsVersion: hired.assignmentsVersion });

  const { projects } = await call('summarize_projects', {});
  assert.deepEqual(projects.map((project) => project.id).sort(), [HOME, DESIGN]);
  assert.equal(JSON.stringify(projects).includes('Synthetic research blocked'), false);
  await assert.rejects(call('summarize_projects', {}, RESEARCH), { code: 'assignment_required' });
});

test('the summary names a few tasks per project and says when more are waiting', async (t) => {
  const { call, seed } = await jefa(t);
  await seed(HOME, ['one', 'two', 'three'].map((name) => ({ title: `Synthetic blocked ${name}`, status: 'blocked' })));

  const [home] = (await call('summarize_projects', { perProject: 2 })).projects;
  assert.equal(home.id, HOME);
  assert.equal(home.counts.blocked, 3, 'the count is whole');
  assert.equal(home.blocked.length, 2);
  assert.equal(home.blockedMore, 1);
  assert.equal(home.awaitingAcceptanceMore, 0);

  const defaulted = (await call('summarize_projects', {})).projects[0];
  assert.equal(defaulted.blocked.length, 3, 'five tasks per project unless asked for fewer');
  await assert.rejects(call('summarize_projects', { perProject: 11 }), { code: 'invalid_input' });
  await assert.rejects(call('summarize_projects', { projectIds: [HOME] }), { code: 'invalid_input' }, 'no project can be named: the host decides which');
});

test('a project tracked on another board says so instead of looking empty', async (t) => {
  const { call } = await jefa(t);
  const { projectBoard } = await call('read_board', {}, DESIGN);
  await call('configure_project_board', { requestId: 'external-1', expectedRevision: projectBoard.revision,
    board: { kind: 'external', external: { url: 'https://tracker.example.test/design' } } }, DESIGN);

  const { projects } = await call('summarize_projects', {});
  assert.equal(projects.find((project) => project.id === DESIGN).board, 'external');
  assert.equal(projects.find((project) => project.id === HOME).board, 'builtin');
});
