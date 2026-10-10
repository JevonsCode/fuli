import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createEmployeeService } from '../src/employees/service.js';
import { parseEmployeeManifest } from '../src/employees/manifest.js';
import { createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

const manifest = parseEmployeeManifest(JSON.parse(readFileSync(new URL('../src/employees/catalog/jefa.json', import.meta.url))));

function fixture(selectedManifest = manifest) {
  const agents = new Map();
  const writes = [];
  const projects = ['project-a', 'project-b', 'project:空 格'].map((id) => ({ project_id: id, profile: { name: id, lifecycle: 'active' } }));
  const app = {
    config: { personal: { spaceId: 'space-a' } },
    async listPersonalProjects() { return structuredClone(projects); },
    async listProjectAgents() { return structuredClone([...agents.values()]); },
    async listCurrentProjectAgents({ projectPath }) { return { personal_project_id: projectPath === '/test/project-a' ? 'project-a' : null }; },
    async upsertProjectAgent(input) {
      writes.push(input);
      const next = { ...input, assignments: agents.get(input.agentId)?.assignments ?? [] };
      agents.set(input.agentId, structuredClone(next));
      return structuredClone(next);
    },
    async createProjectAgentAssignment(input) {
      writes.push(input);
      const agent = agents.get(input.agentId);
      const found = agent.assignments.find((entry) => entry.idempotencyKey === input.idempotencyKey);
      if (found) return structuredClone(found);
      const assignment = { ...input, assignmentId: input.idempotencyKey, status: 'active', revision: 0 };
      agent.assignments.push(assignment);
      return structuredClone(assignment);
    },
    async endProjectAgentAssignment(input) {
      writes.push(input);
      const assignment = [...agents.values()].flatMap((agent) => agent.assignments).find((entry) => entry.assignmentId === input.assignmentId);
      assert.equal(assignment.revision, input.expectedRevision);
      assignment.status = 'ended';
      assignment.revision += 1;
      return structuredClone(assignment);
    }
  };
  const registry = {
    catalog: () => [{ manifest: selectedManifest, runtimeStatus: 'ready' }],
    get(id) { if (id !== selectedManifest.id) throw new TypeError('Unknown template'); return { manifest: selectedManifest, runtimeStatus: 'ready' }; },
    async runtime() { return {
      describeTools: () => [{ name: 'read_board', permission: 'board.read' }],
      callTool: async (_tool, _args, context) => ({ projectId: context.project.id }),
      handleHttp: async (_request, response, context) => { response.end(JSON.stringify({ projectId: context.project.id, basePath: context.basePath })); }
    }; },
    close() {}
  };
  app.employees = createEmployeeService({ app, registry });
  return { app, agents, writes, projects, registry, service: app.employees };
}

test('Tonborg creates its scoped memory assignment only after authorization and preserves its all-project rule', async t => {
  const tonborg = parseEmployeeManifest(JSON.parse(readFileSync(new URL('../src/employees/catalog/tonborg.json', import.meta.url))));
  const { service, agents, writes, app } = fixture(tonborg);
  t.after(() => service.close());
  agents.set('employee.tonborg', { agentId: 'employee.tonborg', assignments: [], profile: {
    status: 'active', allowedClients: ['codex'], capabilities: tonborg.capabilities,
    responsibility: tonborg.description, workKinds: tonborg.workKinds,
  } });
  const input = { templateId: 'tonborg', personalProjectId: 'project-a', sourceApplication: 'codex' };
  await service.authorize(input);
  assert.equal(writes.length, 0);
  await assert.rejects(service.authorize({ ...input, sourceApplication: 'claude_code', ensureAssignment: true }), { status: 403 });
  assert.equal(writes.length, 0);
  await service.authorize({ ...input, ensureAssignment: true });
  await service.authorize({ ...input, ensureAssignment: true });
  assert.equal(agents.get('employee.tonborg').assignments.length, 1);
  assert.equal((await service.list()).templates[0].management.mode, 'all');
  await service.authorize({ ...input, personalProjectId: 'project-b', ensureAssignment: true });
  assert.equal(agents.get('employee.tonborg').assignments.length, 2);
  const ended = agents.get('employee.tonborg').assignments[0];
  await app.endProjectAgentAssignment({ assignmentId: ended.assignmentId, expectedRevision: 0 });
  const count = writes.length;
  await assert.rejects(service.authorize({ ...input, ensureAssignment: true }), { status: 403 });
  assert.equal(writes.length, count);
});

test('a successful employee tool call supplies truthful collaboration evidence', async (t) => {
  const { service } = fixture();
  t.after(() => service.close());
  await service.recruit({ templateId: 'jefa', personalProjectId: 'project-a' });
  const result = await service.callTool({ templateId: 'jefa', personalProjectId: 'project-a', tool: 'read_board', sourceApplication: 'codex' });
  assert.equal(result.collaboration_receipt.agent_id, 'employee.jefa');
  assert.equal(result.collaboration_receipt.name, 'Jefa');
  assert.equal(result.collaboration_receipt.tool, 'read_board');
  assert.equal(result.collaboration_receipt.status, 'tool_completed');
  assert.equal(result.collaboration_receipt.worker_started, false);
  assert.equal(result.collaboration_receipt.personal_project_id, 'project-a');
});

test('employee tool discovery supports exact selection and compact schema-free listings', async (t) => {
  const { service, registry } = fixture();
  t.after(() => service.close());
  const schemas = [
    { name: 'read_board', permission: 'board.read', inputSchema: { type: 'object' } },
    { name: 'create_tasks', permission: 'board.write', inputSchema: { type: 'object' } },
    { name: 'not_permitted', permission: 'unknown.write', inputSchema: { type: 'object' } }
  ];
  registry.runtime = async () => ({ describeTools: () => schemas });
  await service.recruit({ templateId: 'jefa', personalProjectId: 'project-a' });
  const input = { templateId: 'jefa', personalProjectId: 'project-a' };
  const selected = await service.describeTools({ ...input, toolName: 'create_tasks' });
  assert.deepEqual(selected.tools, [schemas[1]]);
  const compact = await service.describeTools({ ...input, includeSchemas: false });
  assert.deepEqual(compact.tools.map(x => x.name), ['read_board', 'create_tasks']);
  assert.ok(compact.tools.every(x => !Object.hasOwn(x, 'inputSchema')));
  assert.deepEqual(schemas[0].inputSchema, { type: 'object' });
  await assert.rejects(service.describeTools({ ...input, toolName: 'not_permitted' }),
    { code: 'tool_not_permitted' });
});

test('the host rejects Jefa human acceptance even if a package would accept it', async (t) => {
  const { service, registry } = fixture();
  t.after(() => service.close());
  let called = false;
  registry.runtime = async () => ({
    describeTools: () => [{ name: 'update_tasks', permission: 'board.write' }],
    callTool: async () => { called = true; return {}; },
  });
  await service.recruit({ templateId: 'jefa', personalProjectId: 'project-a' });
  await assert.rejects(service.callTool({
    templateId: 'jefa', personalProjectId: 'project-a', tool: 'update_tasks',
    arguments: { updates: [{ id: 'task-a', status: 'done' }] },
  }), { code: 'human_acceptance_required' });
  assert.equal(called, false);
});

test('employee recruitment reuses an identity, preserves customization, and assigns projects separately', async () => {
  const { service, agents, writes } = fixture();
  const input = { templateId: 'jefa', personalProjectId: 'project-a' };
  const results = await Promise.all(Array.from({ length: 6 }, () => service.recruit(input)));
  assert.equal(results.filter((entry) => !entry.idempotent).length, 1);
  assert.equal(agents.size, 1);
  assert.equal(writes.length, 2);
  const agent = agents.get('employee.jefa');
  agent.profile.initialPreferences = ['User customization'];
  agent.profile.defaultModelStrategy = { mode: 'deep' };
  await service.recruit({ ...input, personalProjectId: 'project-b' });
  assert.equal(agents.size, 1);
  assert.equal(agent.assignments.length, 2);
  assert.deepEqual(agent.profile.initialPreferences, ['User customization']);
  assert.equal(agent.profile.defaultModelStrategy.mode, 'deep');
});

test('recruitment permits an unassigned identity but workbench access requires an active assignment', async () => {
  const { service, writes } = fixture();
  await service.recruit({ templateId: 'jefa', personalProjectIds: [] });
  assert.equal(writes.length, 1);
  await assert.rejects(service.workspace({ templateId: 'jefa', personalProjectId: 'project-a' }), { code: 'assignment_required' });
  await assert.rejects(service.recruit({ templateId: 'jefa', personalProjectId: 'missing' }), { code: 'project_not_found' });
  await assert.rejects(service.recruit({ templateId: 'jefa', personalSpaceId: 'space-b' }), { code: 'space_mismatch' });
});

test('batch recruitment validates every project before writing and deduplicates retries', async () => {
  const { service, agents, writes } = fixture();
  for (const input of [
    { personalProjectIds: ['project-a', 'missing'] },
    { personalProjectIds: 'project-a' },
    { personalProjectIds: [null] },
    { personalProjectIds: ['project-a'], personalProjectId: 'project-b' },
    { personalProjectIds: [], replaceAssignments: true },
    { personalProjectIds: [], replaceAssignments: 'true' },
    { personalProjectIds: Array(501).fill('project-a') },
  ]) await assert.rejects(service.recruit({ templateId: 'jefa', ...input }));
  assert.equal(writes.length, 0);
  const input = { templateId: 'jefa', personalProjectIds: ['project-a', 'project-b', 'project-a'] };
  const results = await Promise.all([service.recruit(input), service.recruit(input)]);
  assert.equal(agents.size, 1);
  assert.equal(results.filter((entry) => !entry.idempotent).length, 1);
  assert.equal(results[0].assignments.length, 2);
  assert.equal(results[0].agent.assignments.length, 2);
  assert.equal(writes.length, 3);
  assert.match(results[0].assignmentsVersion, /^[a-f0-9]{64}$/);
});

test('all-project selection is a snapshot, and exclusions revoke access without deleting history', async () => {
  const { service, projects, agents } = fixture();
  const all = await service.recruit({ templateId: 'jefa', personalProjectIds: projects.map((entry) => entry.project_id) });
  projects.push({ project_id: 'new-project', profile: { name: 'New', lifecycle: 'active' } });
  await assert.rejects(service.workspace({ templateId: 'jefa', personalProjectId: 'new-project' }), { code: 'assignment_required' });
  const input = { templateId: 'jefa', personalProjectIds: ['project-a', 'project:空 格'], replaceAssignments: true, expectedAssignmentsVersion: all.assignmentsVersion };
  const updated = await service.recruit(input);
  assert.equal(updated.assignments.length, 2);
  assert.equal(updated.endedAssignments.length, 1);
  assert.equal(agents.get('employee.jefa').assignments.length, 3);
  assert.equal(agents.get('employee.jefa').assignments.find((entry) => entry.personalProjectId === 'project-b').status, 'ended');
  await assert.rejects(service.callTool({ templateId: 'jefa', personalProjectId: 'project-b', tool: 'read_board' }), { code: 'assignment_required' });
  assert.equal((await service.recruit(input)).idempotent, true);
  await service.recruit({ templateId: 'jefa', personalProjectIds: ['project-b'] });
  assert.equal(agents.get('employee.jefa').assignments.filter((entry) => entry.personalProjectId === 'project-b').length, 2);
});

test('new Jefa defaults to a persistent all-project rule, including future projects without fabricated assignments', async () => {
  const { service, projects, writes } = fixture();
  const recruited = await service.recruit({ templateId: 'jefa' });
  assert.equal(recruited.management.mode, 'all');
  assert.equal(recruited.assignments.length, 3);
  const writesBefore = writes.length;
  projects.push({ project_id: 'future-project', profile: { name: 'Future', lifecycle: 'active' } });
  const workspace = await service.workspace({ templateId: 'jefa', personalProjectId: 'future-project' });
  assert.equal(workspace.project.id, 'future-project');
  const entry = (await service.list()).templates[0];
  assert.equal(entry.managedProjects.length, 4);
  assert.equal(entry.assignments.length, 3);
  assert.equal(writes.length, writesBefore, 'read operations must not create Provider assignments');
});

test('all-except exclusions gate workspaces, tool calls, and task entry before the runtime is reached', async () => {
  const { service, projects, agents } = fixture();
  const initial = await service.recruit({ templateId: 'jefa' });
  await service.recruit({ templateId: 'jefa', management: { mode: 'all', excludedProjectIds: ['project-b'], titleMode: 'auto' },
    replaceAssignments: true, expectedAssignmentsVersion: initial.assignmentsVersion });
  for (const method of ['workspace', 'describeTools', 'callTool']) {
    await assert.rejects(service[method]({ templateId: 'jefa', personalProjectId: 'project-b', tool: 'read_board' }), { code: 'assignment_required' });
  }
  assert.equal((await service.taskEntry({ personalProjectId: 'project-b' })).managers.length, 0);
  const taskEntry = await service.taskEntry({ personalProjectId: 'project-a' });
  assert.equal(taskEntry.managers[0].template_id, 'jefa');
  assert.match(taskEntry.managers[0].guidance, /end the user-facing response with a short receipt naming that task/);
  assert.equal(agents.get('employee.jefa').assignments.find(a => a.personalProjectId === 'project-b').status, 'ended');
  projects.push({ project_id: 'future-project', profile: { name: 'Future', lifecycle: 'active' } });
  assert.equal((await service.taskEntry({ personalProjectId: 'future-project' })).status, 'ready');
  await assert.rejects(service.recruit({ templateId: 'jefa', personalProjectId: 'project-b' }), { code: 'project_excluded' });
});

test('exclusions remain effective when Provider revocation fails, and policy-only edits have CAS protection', async () => {
  const { service, app, agents } = fixture();
  const initial = await service.recruit({ templateId: 'jefa' });
  app.endProjectAgentAssignment = async () => { throw new Error('Synthetic provider failure'); };
  await assert.rejects(service.recruit({ templateId: 'jefa', management: { mode: 'all', excludedProjectIds: ['project-b'] },
    replaceAssignments: true, expectedAssignmentsVersion: initial.assignmentsVersion }), { code: 'assignment_update_incomplete' });
  assert.equal(agents.get('employee.jefa').assignments.find(a => a.personalProjectId === 'project-b').status, 'active');
  await assert.rejects(service.workspace({ templateId: 'jefa', personalProjectId: 'project-b' }), { code: 'assignment_required' });
  await assert.rejects(service.recruit({ templateId: 'jefa', management: { mode: 'all', excludedProjectIds: ['project-b'], titleMode: 'off' },
    replaceAssignments: true, expectedAssignmentsVersion: initial.assignmentsVersion }), { code: 'assignment_scope_conflict' });
});

test('ending a project assignment also prohibits an all-project manager until explicitly reselected', async () => {
  const { service, app } = fixture();
  const initial = await service.recruit({ templateId: 'jefa' });
  const assignment = initial.assignments.find(a => a.personalProjectId === 'project-b');
  await app.endProjectAgentAssignment({ assignmentId: assignment.assignmentId, expectedRevision: assignment.revision });
  const catalog = (await service.list()).templates[0];
  assert.deepEqual(catalog.management.excludedProjectIds, ['project-b']);
  await assert.rejects(service.workspace({ templateId: 'jefa', personalProjectId: 'project-b' }), { code: 'assignment_required' });
  await service.recruit({ templateId: 'jefa', management: { mode: 'all', excludedProjectIds: [] }, replaceAssignments: true, expectedAssignmentsVersion: catalog.assignmentsVersion });
  assert.equal((await service.workspace({ templateId: 'jefa', personalProjectId: 'project-b' })).project.id, 'project-b');
});

test('scope modes validate before writes and an upgrade never silently widens an existing identity', async () => {
  const { service, writes, agents } = fixture();
  for (const management of [{ mode: 'all', projectIds: ['project-a'] }, { mode: 'selected', excludedProjectIds: ['project-a'] },
    { mode: 'all', excludedProjectIds: ['missing'] }, { mode: 'selected', projectIds: ['missing'] }]) {
    await assert.rejects(service.recruit({ templateId: 'jefa', management }));
  }
  assert.equal(writes.length, 0);
  // An identity with assignment history keeps its selection; ending the last one is a deliberate veto.
  agents.set('employee.jefa', { agentId: 'employee.jefa', profile: { status: 'active', capabilities: ['fuli.employee:jefa'] },
    assignments: [{ personalProjectId: 'project-a', status: 'ended' }] });
  assert.equal((await service.list()).templates[0].management.mode, 'selected');
  await assert.rejects(service.workspace({ templateId: 'jefa', personalProjectId: 'project-a' }), { code: 'assignment_required' });
  // The fixed system identity nobody has assigned yet manages every project by default.
  agents.set('employee.jefa', { agentId: 'employee.jefa', profile: { status: 'active', capabilities: ['fuli.employee:jefa'] }, assignments: [] });
  assert.equal((await service.list()).templates[0].management.mode, 'all');
});

test('replacing assignments rejects stale selections before writing and supports clearing the current scope', async () => {
  const { service, writes, agents } = fixture();
  const initial = await service.recruit({ templateId: 'jefa', personalProjectIds: ['project-a'] });
  const current = await service.recruit({ templateId: 'jefa', personalProjectIds: ['project-b'] });
  const writesBefore = writes.length;
  await assert.rejects(service.recruit({ templateId: 'jefa', personalProjectIds: [], replaceAssignments: true, expectedAssignmentsVersion: initial.assignmentsVersion }), { code: 'assignment_scope_conflict' });
  assert.equal(writes.length, writesBefore);
  const cleared = await service.recruit({ templateId: 'jefa', personalProjectIds: [], replaceAssignments: true, expectedAssignmentsVersion: current.assignmentsVersion });
  assert.equal(cleared.assignments.length, 0);
  assert.equal(cleared.endedAssignments.length, 2);
  assert.equal(agents.size, 1);
  assert.equal(agents.get('employee.jefa').profile.status, 'active');
});

test('archived projects are unavailable for selection and their existing assignment history is preserved', async () => {
  const { service, projects, agents } = fixture();
  const initial = await service.recruit({ templateId: 'jefa', personalProjectIds: ['project-a', 'project-b'] });
  projects.find((entry) => entry.project_id === 'project-b').profile.lifecycle = 'archived';
  await assert.rejects(service.recruit({ templateId: 'jefa', personalProjectIds: ['project-b'] }), { code: 'project_not_found' });
  await service.recruit({ templateId: 'jefa', personalProjectIds: [], replaceAssignments: true, expectedAssignmentsVersion: initial.assignmentsVersion });
  assert.equal(agents.get('employee.jefa').assignments.find((entry) => entry.personalProjectId === 'project-b').status, 'active');
  await assert.rejects(service.workspace({ templateId: 'jefa', personalProjectId: 'project-b' }), { code: 'project_not_found' });
});

test('interrupted scope updates revoke exclusions first and require a reload before continuing', async () => {
  const { service, app, agents } = fixture();
  const initial = await service.recruit({ templateId: 'jefa', personalProjectIds: ['project-a'] });
  const create = app.createProjectAgentAssignment;
  app.createProjectAgentAssignment = async () => { throw new Error('Synthetic provider failure'); };
  const input = { templateId: 'jefa', personalProjectIds: ['project-b'], replaceAssignments: true, expectedAssignmentsVersion: initial.assignmentsVersion };
  await assert.rejects(service.recruit(input), { code: 'assignment_update_incomplete' });
  assert.equal(agents.get('employee.jefa').assignments[0].status, 'ended');
  app.createProjectAgentAssignment = create;
  await assert.rejects(service.recruit(input), { code: 'assignment_scope_conflict' });
  const catalog = await service.list();
  const result = await service.recruit({ ...input, expectedAssignmentsVersion: catalog.templates[0].assignmentsVersion });
  assert.deepEqual(result.assignments.map((entry) => entry.personalProjectId), ['project-b']);
});

test('inactive employees require explicit reactivation and custom identities are never overwritten', async () => {
  const { service, agents } = fixture();
  await service.recruit({ templateId: 'jefa' });
  agents.get('employee.jefa').profile.status = 'archived';
  await assert.rejects(service.recruit({ templateId: 'jefa' }), { code: 'reactivation_required' });
  await service.recruit({ templateId: 'jefa', reactivate: true });
  agents.get('employee.jefa').profile.capabilities = ['custom identity'];
  await assert.rejects(service.recruit({ templateId: 'jefa' }), { code: 'identity_conflict' });
});

test('tool calls bind the resolved project and reject missing assignments, path mismatches, and unknown tools', async () => {
  const { service } = fixture();
  await service.recruit({ templateId: 'jefa', projectPath: '/test/project-a' });
  const result = await service.callTool({ templateId: 'jefa', projectPath: '/test/project-a', tool: 'read_board' });
  assert.equal(result.projectId, 'project-a');
  assert.equal(result.collaboration_receipt.personal_project_id, 'project-a');
  await assert.rejects(service.callTool({ templateId: 'jefa', personalProjectId: 'project-b', tool: 'read_board' }), { code: 'assignment_required' });
  await assert.rejects(service.callTool({ templateId: 'jefa', projectPath: '/test/project-a', personalProjectId: 'project-b', tool: 'read_board' }), { code: 'project_mismatch' });
  await assert.rejects(service.callTool({ templateId: 'jefa', personalProjectId: 'project-a', tool: 'shell' }), { code: 'tool_not_permitted' });
});

test('employee MCP accepts an explicit project ID without weakening assignment or path checks', async (t) => {
  const { app, service } = fixture();
  await service.recruit({ templateId: 'jefa', personalProjectId: 'project-a' });
  const server = createMcpServer(app, { env: {}, registerResources: false });
  const client = new Client({ name: 'employee-explicit-project-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await service.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const scope = { templateId: 'jefa', personalProjectId: 'project-a' };
  const catalog = await client.callTool({ name: 'list_employee_tools', arguments: scope });
  assert.equal(catalog.isError, undefined);
  assert.equal(catalog.structuredContent.project.id, 'project-a');
  const read = (input) => client.callTool({ name: 'call_employee_tool', arguments: {
    ...scope, tool: 'read_board', arguments: {}, ...input
  } });
  assert.equal((await read({})).structuredContent.projectId, 'project-a');
  assert.equal((await read({ personalProjectId: 'project-b' })).structuredContent.error.code, 'assignment_required');
  assert.equal((await read({ personalProjectId: 'missing' })).structuredContent.error.code, 'project_not_found');
  assert.equal((await read({ personalProjectId: 'project-b', projectPath: '/test/project-a' })).structuredContent.error.code, 'project_mismatch');
  assert.equal((await read({ personalProjectId: undefined })).structuredContent.error.code, 'project_required');
});

test('employee HTTP routes and workbench share the host listener and existing origin policy', async (t) => {
  const { app } = fixture();
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const catalog = await fetch(`${url}/api/employee-templates`).then((r) => r.json());
  assert.equal(catalog.templates[0].name, 'Jefa');
  const endpoint = `${url}/api/employee-templates/jefa/recruit`;
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personalProjectId: 'project-a' }) };
  assert.equal((await fetch(endpoint, { ...init, headers: { ...init.headers, origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(endpoint, init)).status, 200);
  const page = await fetch(`${url}/employee-workspaces/jefa/project-a/`).then((r) => r.json());
  assert.equal(page.projectId, 'project-a');
  assert.equal(page.basePath, '/employee-workspaces/jefa/project-a/');
  assert.equal((await fetch(`${url}/employee-workspaces/jefa/project-b/`)).status, 403);
  assert.equal((await fetch(endpoint, { ...init, body: JSON.stringify({ profile: { name: 'overwrite' } }) })).status, 400);
  await app.employees.recruit({ templateId: 'jefa', personalProjectId: 'project:空 格' });
  const encodedProject = await fetch(`${url}/employee-workspaces/jefa/${encodeURIComponent('project:空 格')}/`).then((r) => r.json());
  assert.equal(encodedProject.projectId, 'project:空 格');
});

test('the existing FULI MCP discovers, recruits, and calls employees without a second MCP server', async (t) => {
  const { app } = fixture();
  const server = createMcpServer(app, { env: {} });
  const client = new Client({ name: 'employee-protocol-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const employeeNames = listed.tools.filter(({ name }) => name.includes('employee')).map(({ name }) => name);
  assert.deepEqual(employeeNames, ['list_employee_templates', 'recruit_employee', 'list_employee_tools', 'call_employee_tool']);
  const catalog = await client.callTool({ name: 'list_employee_templates', arguments: {} });
  assert.equal(catalog.structuredContent.templates[0].name, 'Jefa');
  const recruited = await client.callTool({ name: 'recruit_employee', arguments: { templateId: 'jefa', projectPath: '/test/project-a' } });
  assert.equal(recruited.isError, undefined);
  const board = await client.callTool({ name: 'call_employee_tool', arguments: { templateId: 'jefa', projectPath: '/test/project-a', tool: 'read_board', arguments: {} } });
  assert.equal(board.structuredContent.projectId, 'project-a');
  const invalid = await client.callTool({ name: 'call_employee_tool', arguments: { templateId: 'jefa', projectPath: '/test/project-a', tool: 'shell', arguments: {} } });
  assert.equal(invalid.isError, true);
  const batch = await client.callTool({ name: 'recruit_employee', arguments: { templateId: 'jefa', personalProjectIds: ['project-a', 'project-b'] } });
  assert.equal(batch.isError, undefined);
  assert.equal(batch.structuredContent.assignments.length, 2);
  const conflict = await client.callTool({ name: 'recruit_employee', arguments: {
    templateId: 'jefa', personalProjectIds: [], replaceAssignments: true,
    expectedAssignmentsVersion: recruited.structuredContent.assignmentsVersion,
  } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.code, 'assignment_scope_conflict');
  const replaced = await client.callTool({ name: 'recruit_employee', arguments: {
    templateId: 'jefa', personalProjectIds: ['project-b'], replaceAssignments: true,
    expectedAssignmentsVersion: batch.structuredContent.assignmentsVersion,
  } });
  assert.equal(replaced.isError, undefined);
  assert.deepEqual(replaced.structuredContent.assignments.map((entry) => entry.personalProjectId), ['project-b']);
  assert.equal(listed.tools.find(({ name }) => name === 'recruit_employee').annotations.destructiveHint, true);
});
