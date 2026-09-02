// Opt-in real HTTP/Neo4j fixture. All identity, context and memory data is synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const realTaskContextEnabled = process.env.FULI_TEST_NEO4J_EPHEMERAL === '1'
  && Boolean(process.env.FULI_TEST_NEO4J_URI);

export async function realTaskContextProvider(t) {
  assert.equal(realTaskContextEnabled, true);
  assert.equal(new URL(process.env.FULI_TEST_NEO4J_URI).hostname, '127.0.0.1');
  const socket = createServer();
  await new Promise(resolveListen => socket.listen(0, '127.0.0.1', resolveListen));
  const port = socket.address().port;
  await new Promise(resolveClose => socket.close(resolveClose));
  const url = `http://127.0.0.1:${port}`;
  const bootstrap = randomUUID();
  const provider = spawn(resolve('graph-provider/.venv/bin/python'), [
    '-m', 'uvicorn', 'fuli_graph.app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'error'
  ], { cwd: resolve('graph-provider'), env: {
    PATH: process.env.PATH, PYTHONUNBUFFERED: '1', GRAPHITI_TELEMETRY_ENABLED: 'false',
    FULI_PROVIDER_ID: 'task-memory-atomicity-acceptance', FULI_PROVIDER_MODE: 'personal',
    FULI_BOOTSTRAP_TOKEN: bootstrap, FULI_NEO4J_URI: process.env.FULI_TEST_NEO4J_URI,
    FULI_NEO4J_PASSWORD: process.env.FULI_TEST_NEO4J_PASSWORD ?? 'fixture-pass'
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(provider, 'close');
  let errors = '';
  provider.stderr.on('data', chunk => { errors = (errors + chunk).slice(-3000); });
  t.after(async () => {
    if (provider.exitCode !== null || provider.signalCode !== null) return;
    provider.kill('SIGTERM');
    const escalation = setTimeout(() => provider.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(escalation); }
  });
  for (let attempt = 0; ; attempt += 1) {
    assert.equal(provider.exitCode, null, 'Fixture Provider exited during startup');
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) break; }
    catch { /* starting */ }
    if (attempt >= 400) assert.fail(`Fixture Provider startup timed out: ${errors}`);
    await delay(100);
  }
  let token;
  async function request(path, body, method = 'POST') {
    const response = await fetch(`${url}${path}`, { method,
      headers: { 'content-type': 'application/json', ...(token
        ? { authorization: `Bearer ${token}` } : { 'x-fuli-bootstrap-token': bootstrap }) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.ok, true, `Fixture HTTP ${response.status}: ${path}`);
    return response.json();
  }
  const principal = await request('/v1/bootstrap', { principal_name: 'Synthetic checkpoint race' });
  token = principal.access_token;
  const space = await request('/v1/spaces', { name: 'Synthetic checkpoint race', kind: 'personal' });
  const projectId = 'synthetic-checkpoint-project';
  await request('/v1/personal-projects', { personal_space_id: space.id, project_id: projectId,
    profile: { name: 'Synthetic checkpoint project', lifecycle: 'active' } }, 'PUT');
  await request('/v1/project-agents', { personal_space_id: space.id,
    personal_project_id: projectId, agent_id: 'engineer', profile: {
      name: 'Synthetic engineer', responsibility: 'Maintain the synthetic sample.',
      allowed_clients: ['codex', 'claude'], work_kinds: ['implementation'],
      capabilities: ['coding']
    } }, 'PUT');
  const context = { personal_space_id: space.id, personal_project_id: projectId,
    project_agent_id: 'engineer', session_id: `synthetic-session-${randomUUID()}`,
    token: `fuli-task-${randomUUID()}`, source_application: 'codex', turn_id: 'turn-one' };
  await request('/v1/task-contexts', context, 'PUT');
  return { request, context, config: { version: 1, personal: { providerUrl: url,
    accessToken: token, principalId: principal.principal_id, spaceId: space.id }, workspaces: [] },
  memory: () => request(`/v1/project-agents/engineer/memory?${new URLSearchParams({
    personal_space_id: space.id, personal_project_id: projectId })}`, undefined, 'GET') };
}
