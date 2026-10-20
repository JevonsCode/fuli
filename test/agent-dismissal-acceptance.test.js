import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { connectMcp } from '../test-support/mcp-client.js';

const enabled = process.env.FULI_TEST_NEO4J_EPHEMERAL === '1' && process.env.FULI_TEST_NEO4J_URI;
const REASON = 'Reported finished work without running the test suite, twice in one week.';
const LESSON = 'Run the relevant test suite before reporting a task as done.';

test('real Neo4j + HTTP Provider + MCP: Bole dismisses with a reason and later Agents find the lesson on demand', {
  skip: !enabled, timeout: 180_000
}, async (t) => {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.FULI_TEST_NEO4J_URI).hostname));
  const directory = mkdtempSync(join(tmpdir(), 'fuli-dismissal-mcp-'));
  // Close the MCP host and the Provider before removing their files (Windows holds open handles).
  const cleanups = [() => rmSync(directory, { recursive: true, force: true, maxRetries: 5 })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const projectId = 'synthetic-dismissal-project';
  const projectPath = join(directory, projectId);
  mkdirSync(projectPath);
  const { request, token, principal } = await disposableProvider(cleanups);
  const space = await request('/v1/spaces', { name: 'Synthetic dismissal acceptance', kind: 'personal' }, { token });
  const scope = { personal_space_id: space.id, personal_project_id: projectId };
  await request('/v1/personal-projects', { personal_space_id: space.id, project_id: projectId,
    profile: { name: 'Synthetic dismissal project', lifecycle: 'active',
      purpose: 'Verify Bole dismissal with synthetic Agents.' } }, { token, method: 'PUT' });
  for (const agentId of ['leaver', 'lead']) {
    await request('/v1/project-agents', { ...scope, agent_id: agentId, occupation: { role: 'engineering' },
      profile: { name: `Synthetic ${agentId}`, responsibility: 'Maintain the synthetic sample.',
        allowed_clients: ['claude_code'], work_kinds: ['implementation'], capabilities: ['coding'] }
    }, { token, method: 'PUT' });
  }
  await request('/v1/project-agent-coordination-policy', { ...scope, ask_before_recruitment: true,
    auto_reuse_previous_agent: true, team_lead_agent_id: 'lead' }, { token, method: 'PUT' });
  for (const personalProjectId of [null, projectId]) {
    await request('/v1/project-agents/leaver/memory', { personal_space_id: space.id,
      personal_project_id: personalProjectId, agent_id: 'leaver', expected_revision: 0,
      idempotency_key: `synthetic-leaver-${personalProjectId ?? 'global'}`, source_application: 'claude_code',
      memory: { summary: `Synthetic ${personalProjectId ? 'project' : 'global'} notes for the successor.` }
    }, { token, method: 'PUT' });
  }
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({ version: 1, personal: { providerUrl: request.url,
    accessToken: token, principalId: principal.principal_id, spaceId: space.id }, workspaces: [] }), { mode: 0o600 });

  const connection = await connectMcp(runtimeConfigPath, { sourceApplication: 'claude_code' });
  cleanups.push(() => connection.close());
  const call = async (name, args, { error = false } = {}) => {
    const result = await connection.client.callTool({ name, arguments: args });
    assert.equal(result.isError === true, error, `${name}: ${JSON.stringify(result)}`);
    return result.structuredContent;
  };
  const before = await call('get_project_agent', { personalSpaceId: space.id, agentId: 'leaver' });
  await call('dismiss_project_agent', { personalSpaceId: space.id, agentId: 'leaver', reason: 'archived by user' },
    { error: true });
  const refusedLead = await connection.client.callTool({ name: 'dismiss_project_agent', arguments: {
    personalSpaceId: space.id, agentId: 'lead', reason: 'Synthetic attempt to remove the lead.' } });
  assert.equal(refusedLead.isError, true);
  assert.match(JSON.stringify(refusedLead), /hand off/);

  const receipt = await call('dismiss_project_agent', { personalSpaceId: space.id, agentId: 'leaver',
    reason: REASON, lessons: [LESSON] });
  assert.equal(receipt.status, 'dismissed');
  assert.equal(receipt.employeeNumber, before.employeeNumber);
  assert.deepEqual(receipt.projectIds, [projectId]);
  assert.equal(JSON.stringify(receipt).includes('notes for the successor'), false);

  const after = await call('get_project_agent', { personalSpaceId: space.id, agentId: 'leaver' });
  assert.equal(after.profile.status, 'archived');
  assert.equal(after.archiveReason, REASON);
  const handoff = await call('get_agent_handoff', { personalSpaceId: space.id, agentId: 'leaver' });
  for (const text of [REASON, LESSON, 'Synthetic global notes for the successor.', 'Synthetic project notes for the successor.']) {
    assert.ok(handoff.handoff.markdown.includes(text), text);
  }

  await request('/v1/project-agents', { ...scope, agent_id: 'newcomer', occupation: { role: 'engineering' },
    profile: { name: 'Synthetic newcomer', responsibility: 'Maintain the synthetic sample.',
      allowed_clients: ['claude_code'], work_kinds: ['implementation'], capabilities: ['coding'] }
  }, { token, method: 'PUT' });
  const newcomer = await call('get_project_agent', { personalSpaceId: space.id, agentId: 'newcomer' });
  assert.ok(Number(newcomer.employeeNumber) > Number(before.employeeNumber), 'employee numbers are never reused');
  const started = await call('get_project_agent_context', { projectPath, agentId: 'newcomer',
    queries: ['synthetic sample'] });
  assert.equal(started.dismissal_lessons.count, 1);
  assert.equal(started.dismissal_lessons.tool, 'list_agent_dismissal_lessons');
  const entryText = JSON.stringify(started);
  assert.equal(entryText.includes(LESSON) || entryText.includes(REASON), false, 'lessons are never injected');
  const found = await call('list_agent_dismissal_lessons', started.dismissal_lessons.arguments);
  assert.equal(found.total, 1);
  assert.deepEqual(found.lessons[0].lessons, [LESSON]);
  assert.equal(found.lessons[0].reason, REASON);

  const recruiting = await call('coordinate_project_agent_task', { projectPath,
    idempotencyKey: 'synthetic-dismissal-recruitment', title: 'Synthetic recruitment',
    objective: 'Recruit another engineer for the synthetic sample.', workKind: 'implementation',
    staffingIntent: 'new_durable', recruitmentOccupation: { role: 'engineering' }, start: false,
    contextQueries: ['synthetic sample'],
    routingReason: 'Synthetic recruitment after a dismissal.' });
  assert.equal(recruiting.status, 'awaiting_recruitment', JSON.stringify(recruiting).slice(0, 2000));
  assert.equal(recruiting.dismissal_lessons.count, 1);
  assert.equal(JSON.stringify(recruiting).includes(LESSON), false);
});

async function disposableProvider(cleanups) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const bootstrapToken = 'synthetic-dismissal-bootstrap-123456';
  const processHandle = spawn(process.env.FULI_TEST_PYTHON ?? resolve('graph-provider/.venv/bin/python'), [
    '-m', 'uvicorn', 'fuli_graph.app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'error'
  ], { cwd: resolve('graph-provider'), env: { PATH: process.env.PATH, PYTHONUNBUFFERED: '1',
    SYSTEMROOT: process.env.SYSTEMROOT, FULI_PROVIDER_ID: 'agent-dismissal-acceptance', FULI_PROVIDER_MODE: 'personal',
    FULI_BOOTSTRAP_TOKEN: bootstrapToken, FULI_NEO4J_URI: process.env.FULI_TEST_NEO4J_URI,
    FULI_NEO4J_PASSWORD: process.env.FULI_TEST_NEO4J_PASSWORD ?? 'fixture-pass' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(processHandle, 'exit');
  const errors = [];
  processHandle.stderr.on('data', chunk => errors.push(chunk.toString()));
  cleanups.push(async () => { processHandle.kill('SIGTERM'); await closed; });
  for (let attempt = 0; ; attempt += 1) {
    if (processHandle.exitCode !== null) assert.fail(`Disposable Provider failed to start: ${errors.join('').slice(-3000)}`);
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
    if (attempt === 399) assert.fail(`Disposable Provider did not become healthy: ${errors.join('').slice(-3000)}`);
    await delay(100);
  }
  async function request(path, body, { token = null, method = 'POST' } = {}) {
    const response = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : { 'x-fuli-bootstrap-token': bootstrapToken }) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.ok, true, `Fixture HTTP ${response.status}: ${path} ${await response.clone().text()}`);
    return response.json();
  }
  request.url = url;
  const principal = await request('/v1/bootstrap', { principal_name: 'Synthetic dismissal acceptance' });
  return { request, token: principal.access_token, principal };
}

async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}
