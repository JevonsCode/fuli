import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createProjectAgentAssignment } from '../src/graphiti/project-agent-workflows.js';
import { createEmployeeFixture } from '../test-support/employee-fixture.js';

// A project's own project manager and board on Jefa's built-in board
// (Notion 「更好的项目管理」). Synthetic FULI directories only.
const PROJECT = 'employee-qa';
const COLUMNS = [
  { label: '待开发', mapsTo: 'planned' }, { label: '发布到测试环境', mapsTo: 'active' },
  { label: '待提测', mapsTo: 'review' }, { label: '上线', mapsTo: 'active' }, { label: '已完成', mapsTo: 'done' }
];

async function jefa(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-jefa-project-boards-'));
  const app = createEmployeeFixture({ runtimeConfigPath: join(root, 'host/graph-runtime.json') });
  // The store closes before its directory goes (Windows locks open files).
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  await app.employees.recruit({ templateId: 'jefa' });
  const call = (tool, args, personalProjectId = PROJECT) =>
    app.employees.callTool({ templateId: 'jefa', personalProjectId, tool, arguments: args });
  return { app, call };
}

async function projectAgent(app, agentId, { personalProjectId = PROJECT, capabilities = [] } = {}) {
  await app.upsertProjectAgent({ personalSpaceId: 'employee-test-space', agentId,
    profile: { name: agentId, responsibility: 'Synthetic project management', status: 'active', capabilities },
    occupation: { role: 'management', tags: [] } });
  if (personalProjectId) {
    await app.createProjectAgentAssignment({ personalSpaceId: 'employee-test-space', personalProjectId, agentId,
      idempotencyKey: `assign-${agentId}`, responsibility: 'Synthetic project management', reason: 'Synthetic test' });
  }
}

function personMove(app, itemId, body) {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'PATCH', socket: { remoteAddress: '127.0.0.1' } });
  let status;
  let payload = '';
  const response = { writeHead(code) { status = code; }, setHeader() {}, end(chunk) { payload += chunk ?? ''; } };
  return app.employees.handleHttp(request, response, { templateId: 'jefa', personalProjectId: PROJECT,
    relativePath: `/api/work-items/${itemId}/status` }).then(() => ({ status, body: JSON.parse(payload || '{}') }));
}

test('a project board names the person\'s own columns; tasks keep a column and the built-in state Jefa reads', async (t) => {
  const { app, call } = await jefa(t);
  const initial = (await call('read_board', { limit: 1 })).projectBoard;
  assert.deepEqual(initial, { projectId: PROJECT, revision: 0, managerAgentId: null, board: { kind: 'builtin', columns: [] }, updatedAt: null });

  const request = { requestId: 'columns-1', expectedRevision: 0, board: { kind: 'builtin', columns: COLUMNS } };
  const { projectBoard } = await call('configure_project_board', request);
  assert.equal(projectBoard.revision, 1);
  assert.deepEqual(projectBoard.board.columns.map(({ label, mapsTo }) => ({ label, mapsTo })), COLUMNS);
  assert.ok(projectBoard.board.columns.every(({ id }) => /^col-[0-9a-f]{8}$/.test(id)));
  assert.deepEqual((await call('configure_project_board', request)).projectBoard, projectBoard, 'a retry returns the same columns');
  await assert.rejects(call('configure_project_board', { ...request, requestId: 'columns-stale' }), { code: 'version_conflict' });
  await assert.rejects(call('configure_project_board', { requestId: 'dup', board: { kind: 'builtin',
    columns: [{ label: '上线', mapsTo: 'active' }, { label: ' 上线 ', mapsTo: 'done' }] } }), { code: 'invalid_input' });
  await assert.rejects(call('configure_project_board', { requestId: 'nothing' }), { code: 'invalid_input' });

  const [todo, testing, review, live, done] = projectBoard.board.columns;
  const { createdWorkItems: [task] } = await call('create_tasks', { messageId: 'seed', tasks: [{ title: 'Synthetic release', boardColumn: live.id }] });
  assert.equal(task.status, 'active');
  assert.equal(task.boardColumn, live.id);
  await assert.rejects(call('create_tasks', { messageId: 'mismatch', tasks: [{ title: 'Synthetic mismatch', status: 'planned', boardColumn: live.id }] }),
    { code: 'invalid_input' });
  await assert.rejects(call('create_tasks', { messageId: 'unknown', tasks: [{ title: 'Synthetic unknown', boardColumn: 'col-unknown' }] }),
    { code: 'invalid_input' });

  // Two columns stand for active: moving between them keeps the state and changes the column.
  const moved = (await call('update_tasks', { requestId: 'to-testing', updates: [{ id: task.id, expectedUpdatedAt: task.updatedAt,
    boardColumn: testing.id }] })).updatedWorkItems[0];
  assert.deepEqual([moved.status, moved.boardColumn], ['active', testing.id]);
  // An Agent never reaches done, not through a column either.
  await assert.rejects(call('update_tasks', { requestId: 'to-done', updates: [{ id: task.id, expectedUpdatedAt: moved.updatedAt,
    boardColumn: done.id }] }), { code: 'human_acceptance_required' });
  // A state change alone leaves the column: the task shows in the first column for its state.
  const reviewed = (await call('update_tasks', { requestId: 'to-review', updates: [{ id: task.id, expectedUpdatedAt: moved.updatedAt,
    status: 'review' }] })).updatedWorkItems[0];
  assert.equal(reviewed.status, 'review');
  assert.equal(reviewed.boardColumn, undefined);

  // The person accepts in the console, moving the card to their own done column.
  await assert.rejects(personMove(app, task.id, { status: 'review', boardColumn: done.id }), { code: 'invalid_input' });
  const accepted = await personMove(app, task.id, { status: 'done', boardColumn: done.id });
  assert.equal(accepted.status, 200);
  assert.deepEqual([accepted.body.workItem.status, accepted.body.workItem.boardColumn], ['done', done.id]);
  assert.ok(accepted.body.workItem.acceptedAt);
  const history = (await call('get_task', { workItemId: task.id })).item.history;
  assert.deepEqual(history.map((entry) => [entry.actor, entry.status]), [['person', 'done'], ['agent', 'review'], ['agent', 'active'], ['agent', 'active']]);

  // Renaming and reordering keeps each column's id, so tasks stay where they were.
  const renamed = (await call('configure_project_board', { requestId: 'rename', expectedRevision: 1, board: { kind: 'builtin',
    columns: [{ ...done, label: '完成' }, todo, testing, review, live] } })).projectBoard;
  assert.deepEqual(renamed.board.columns.map(({ id }) => id), [done.id, todo.id, testing.id, review.id, live.id]);
  assert.equal(renamed.board.columns[0].label, '完成');
  assert.equal((await call('read_board', {})).items[0].boardColumn, done.id);
  assert.equal(renamed.managerAgentId, null, 'an omitted manager keeps its value');
});

test('an external board is only a link, and moves never go to a column there', async (t) => {
  const { call } = await jefa(t);
  const { createdWorkItems: [task] } = await call('create_tasks', { messageId: 'seed', tasks: [{ title: 'Synthetic tracked elsewhere' }] });
  await assert.rejects(call('configure_project_board', { requestId: 'script', board: { kind: 'external', external: { url: 'javascript:alert(1)' } } }),
    { code: 'invalid_input' });
  await assert.rejects(call('configure_project_board', { requestId: 'secret', board: { kind: 'external',
    external: { url: 'https://user:pass@project.example.test/board' } } }), { code: 'invalid_input' });
  await assert.rejects(call('configure_project_board', { requestId: 'mixed', board: { kind: 'external', columns: COLUMNS,
    external: { url: 'https://project.example.test/board' } } }), { code: 'invalid_input' });
  const { projectBoard } = await call('configure_project_board', { requestId: 'external', board: { kind: 'external',
    external: { url: 'https://project.example.test/synthetic/board', label: ' 飞书项目 ' } } });
  assert.deepEqual(projectBoard.board, { kind: 'external', external: { url: 'https://project.example.test/synthetic/board', label: '飞书项目' } });
  assert.deepEqual((await call('read_board', {})).projectBoard.board, projectBoard.board);
  await assert.rejects(call('update_tasks', { requestId: 'column', updates: [{ id: task.id, expectedUpdatedAt: task.updatedAt, boardColumn: 'col-any' }] }),
    { code: 'invalid_input' });
  assert.equal((await call('read_board', {}, 'employee-qa-design')).projectBoard.revision, 0, 'each project has its own board');
});

test('a project manager is one of the project\'s own Agents, never a peer role or an unassigned Agent', async (t) => {
  const { app, call } = await jefa(t);
  await projectAgent(app, 'synthetic-pm');
  await projectAgent(app, 'synthetic-elsewhere', { personalProjectId: 'employee-qa-design' });
  await projectAgent(app, 'synthetic-peer', { capabilities: ['fuli.employee:bole'] });
  await assert.rejects(call('configure_project_board', { requestId: 'unknown', managerAgentId: 'missing-agent' }), { code: 'project_manager_not_assigned' });
  await assert.rejects(call('configure_project_board', { requestId: 'other', managerAgentId: 'synthetic-elsewhere' }), { code: 'project_manager_not_assigned' });
  await assert.rejects(call('configure_project_board', { requestId: 'peer', managerAgentId: 'synthetic-peer' }), { code: 'project_manager_peer_role' });
  const { projectBoard } = await call('configure_project_board', { requestId: 'pm', managerAgentId: 'synthetic-pm' });
  assert.equal(projectBoard.managerAgentId, 'synthetic-pm');
  assert.deepEqual(projectBoard.board, { kind: 'builtin', columns: [] }, 'an omitted board keeps its value');
  assert.equal((await call('configure_project_board', { requestId: 'back-to-jefa', managerAgentId: null })).projectBoard.managerAgentId, null);
});

test('the assignment tool gives a project its own manager and board in one call, and a retry finishes it', async (t) => {
  const { app, call } = await jefa(t);
  await projectAgent(app, 'synthetic-new-pm', { personalProjectId: null });
  // The provider side of the assignment, on the fixture's synthetic records.
  const application = { employees: app.employees, personal: { createProjectAgentAssignment: async (input) => {
    const record = await app.createProjectAgentAssignment({ personalSpaceId: input.personal_space_id,
      personalProjectId: input.personal_project_id, agentId: input.agent_id, idempotencyKey: input.idempotency_key,
      responsibility: input.responsibility, reason: input.reason });
    return { assignment_id: record.assignmentId, personal_project_id: record.personalProjectId, agent_id: record.agentId, status: record.status };
  } } };
  const input = { personalSpaceId: 'employee-test-space', personalProjectId: PROJECT, agentId: 'synthetic-new-pm',
    idempotencyKey: 'assign-new-pm', responsibility: '活动项目经理', reason: 'Synthetic: give the project its own PM',
    projectManager: { board: { kind: 'builtin', columns: COLUMNS.slice(0, 2) } } };

  await assert.rejects(createProjectAgentAssignment(application, { ...input, idempotencyKey: 'bad-board',
    projectManager: { board: { kind: 'external', external: { url: 'ftp://project.example.test' } } } }), { code: 'invalid_input' });
  assert.equal((await app.listProjectAgents()).find((agent) => agent.agentId === 'synthetic-new-pm').assignments.length, 0,
    'an invalid board writes no assignment');

  const assigned = await createProjectAgentAssignment(application, input);
  assert.equal(assigned.status, 'active');
  assert.equal(assigned.projectBoard.managerAgentId, 'synthetic-new-pm');
  assert.deepEqual(assigned.projectBoard.board.columns.map(({ label }) => label), ['待开发', '发布到测试环境']);
  assert.deepEqual((await createProjectAgentAssignment(application, input)).projectBoard, assigned.projectBoard, 'a retry changes nothing');
  assert.equal((await call('read_board', {})).projectBoard.revision, 1);

  const unreachable = { ...application, employees: { callTool: async () => { throw Object.assign(new Error('Jefa is not here'), { code: 'assignment_required' }); } } };
  await assert.rejects(createProjectAgentAssignment(unreachable, { ...input, idempotencyKey: 'assign-again' }),
    (error) => error.code === 'project_board_not_saved' && /same idempotencyKey/.test(error.message));
});
