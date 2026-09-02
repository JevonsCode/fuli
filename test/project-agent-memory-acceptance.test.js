import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { connectMcp } from '../test-support/mcp-client.js';

const enabled = process.env.FULI_TEST_NEO4J_EPHEMERAL === '1' && process.env.FULI_TEST_NEO4J_URI;

test('real Neo4j + HTTP Provider + independent MCP hosts retain one role across client switches', {
  skip: !enabled, timeout: 180_000
}, async (t) => {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.FULI_TEST_NEO4J_URI).hostname));
  const directory = mkdtempSync(join(tmpdir(), 'fuli-role-mcp-'));
  const projectId = 'synthetic-role-project';
  const projectPath = join(directory, projectId);
  mkdirSync(projectPath);
  const port = await freePort();
  const providerUrl = `http://127.0.0.1:${port}`;
  const bootstrapToken = 'synthetic-mcp-bootstrap-123456';
  const processHandle = spawn(resolve('graph-provider/.venv/bin/python'), [
    '-m', 'uvicorn', 'fuli_graph.app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'error'
  ], { cwd: resolve('graph-provider'), env: {
    PATH: process.env.PATH, PYTHONUNBUFFERED: '1',
    FULI_PROVIDER_ID: 'agent-memory-acceptance',
    FULI_PROVIDER_MODE: 'personal', FULI_BOOTSTRAP_TOKEN: bootstrapToken,
    FULI_NEO4J_URI: process.env.FULI_TEST_NEO4J_URI,
    FULI_NEO4J_PASSWORD: process.env.FULI_TEST_NEO4J_PASSWORD ?? 'fixture-pass'
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(processHandle, 'exit');
  const errors = [];
  processHandle.stderr.on('data', chunk => errors.push(chunk.toString()));
  t.after(async () => { processHandle.kill('SIGTERM'); await closed; });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (processHandle.exitCode !== null) assert.fail('Disposable Provider failed to start');
    try { if ((await fetch(`${providerUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
    if (attempt === 399) assert.fail(`Disposable Provider did not become healthy: ${errors.join('').slice(-3000)}`);
    await delay(100);
  }
  async function request(path, body, { token = null, method = 'POST' } = {}) {
    const response = await fetch(`${providerUrl}${path}`, {
      method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : { 'x-fuli-bootstrap-token': bootstrapToken }) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.equal(response.ok, true, `Fixture HTTP ${response.status}: ${path}`);
    return response.json();
  }
  const principal = await request('/v1/bootstrap', { principal_name: 'Synthetic cross-host acceptance' });
  const token = principal.access_token;
  const space = await request('/v1/spaces', { name: 'Synthetic role MCP acceptance', kind: 'personal' }, { token });
  await request('/v1/personal-projects', {
    personal_space_id: space.id, project_id: projectId,
    profile: { name: 'Synthetic role project', lifecycle: 'active' }
  }, { token, method: 'PUT' });
  for (const [agentId, workKind, capability] of [
    ['engineer', 'implementation', 'coding'], ['reviewer', 'code_review', 'review'],
    ['backup-engineer', 'implementation', 'coding']
  ]) {
    await request('/v1/project-agents', {
      personal_space_id: space.id, personal_project_id: projectId, agent_id: agentId,
      profile: { name: `Synthetic ${agentId}`, responsibility: 'Maintain the synthetic sample.',
        allowed_clients: ['codex', 'claude', 'claude_code', 'cursor'], work_kinds: [workKind], capabilities: [capability] }
    }, { token, method: 'PUT' });
  }
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({ version: 1,
    personal: { providerUrl, accessToken: token, principalId: principal.principal_id, spaceId: space.id },
    workspaces: []
  }), { mode: 0o600 });
  let revision = 0;
  for (const sourceApplication of ['codex', 'claude', 'claude_code', 'cursor']) {
    const connection = await connectMcp(runtimeConfigPath, { sourceApplication });
    const sessionId = `synthetic-${sourceApplication}-session`;
    let tokenForTask;
    try {
      const begun = await connection.client.callTool({ name: 'begin_task_context', arguments: {
        sessionId, turnId: 'synthetic-turn-one', projectPath, taskPrompt: 'Implement the synthetic service.',
        workKind: 'implementation', requiredCapabilities: ['coding']
      } });
      assert.equal(begun.isError, undefined, JSON.stringify(begun));
      const value = begun.structuredContent;
      assert.equal(value.context.project_agent_id, 'engineer');
      assert.equal(value.project_agent_context.status, 'ready');
      assert.equal(value.project_agent_context.worker_started, false);
      assert.equal(value.project_agent_context.memory.revision, revision);
      if (revision) assert.equal(value.project_agent_context.memory.current.memory.summary, `Synthetic milestone ${revision}.`);
      tokenForTask = value.task_context_token;
      const sameTurn = await connection.client.callTool({ name: 'begin_task_context', arguments: {
        sessionId, turnId: 'synthetic-turn-one', projectPath, taskPrompt: 'Implement the synthetic service.',
        workKind: 'implementation', requiredCapabilities: ['coding']
      } });
      assert.equal(sameTurn.isError, undefined, JSON.stringify(sameTurn));
      assert.equal(sameTurn.structuredContent.task_context_token, tokenForTask);
      const fallback = await connection.client.callTool({ name: 'get_collaboration_preferences', arguments: {
        sessionId, projectPath, taskPrompt: 'Implement the synthetic service.'
      } });
      assert.equal(fallback.structuredContent.context.project_agent_id, 'engineer');
    } finally { await connection.close(); }

    // A separate Node/MCP process performs Stop and final memory write.
    const finisher = await connectMcp(runtimeConfigPath, { sourceApplication });
    try {
      const pending = await finisher.client.callTool({ name: 'verify_task_checkpoint', arguments: { sessionId } });
      assert.equal(pending.structuredContent.status, 'checkpoint_required');
      assert.equal(pending.structuredContent.task_context_token, tokenForTask);
      const resumed = await finisher.client.callTool({ name: 'begin_task_context', arguments: {
        sessionId, projectPath, taskPrompt: pending.structuredContent.reason
      } });
      assert.equal(resumed.structuredContent.task_context_token, tokenForTask);
      assert.equal(resumed.structuredContent.resumed_checkpoint, true);
      const rejected = await finisher.client.callTool({ name: 'checkpoint_task_knowledge', arguments: {
        taskContextToken: tokenForTask, disposition: 'capture_candidates',
        reason: 'The synthetic candidate still needs a reasoning summary.',
        capture: invalidCapture(),
        agentMemory: { expectedRevision: revision, memory: {
          summary: 'This rejected batch must not advance working memory.'
        } }
      } });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent.error.code, 'validation');
      const unchanged = await finisher.client.callTool({ name: 'get_project_agent_memory', arguments: {
        personalSpaceId: space.id, personalProjectId: projectId, agentId: 'engineer'
      } });
      assert.equal(unchanged.isError, undefined, JSON.stringify(unchanged));
      assert.equal(unchanged.structuredContent.revision, revision);
      const saved = await finisher.client.callTool({ name: 'checkpoint_task_knowledge', arguments: {
        taskContextToken: tokenForTask, disposition: 'retain_nothing',
        reason: 'Only private working context changed in this synthetic test.',
        agentMemory: { expectedRevision: revision, memory: {
          summary: `Synthetic milestone ${revision + 1}.`, nextActions: ['Continue the same role in the next host.']
        } }
      } });
      assert.equal(saved.isError, undefined, JSON.stringify(saved));
      assert.equal(saved.structuredContent.agent_memory.revision, ++revision);
      assert.equal(saved.structuredContent.agent_memory.sourceApplication, sourceApplication);
    } finally { await finisher.close(); }
    const verifier = await connectMcp(runtimeConfigPath, { sourceApplication });
    try {
      const verified = await verifier.client.callTool({ name: 'verify_task_checkpoint', arguments: { sessionId } });
      assert.equal(verified.structuredContent.status, 'checkpointed');
    } finally { await verifier.close(); }
  }
  assert.equal(revision, 4);
  assert.equal(errors.join('').includes('Traceback'), false);
});

function invalidCapture() {
  return {
    idempotencyKey: 'synthetic-incomplete-capture', name: 'Synthetic open question',
    sourceKind: 'synthetic_test', sourceDescription: 'Synthetic fixture, not production knowledge.',
    referenceTime: '2026-08-30T00:00:00.000Z',
    entities: [{
      key: 'synthetic.open-question', name: 'Synthetic tradeoff', type: 'TestKnowledge',
      originQuadrant: 'known_unknown', confirmationStatus: 'pending',
      confirmationBasis: {
        existenceReason: 'The fixture raises an unresolved question.',
        quadrantReason: 'The question is recognized but unresolved.',
        proposedBy: { kind: 'agent' }
      }
    }],
    relationships: []
  };
}

async function freePort() {
  const socket = createServer();
  await new Promise(resolveListen => socket.listen(0, '127.0.0.1', resolveListen));
  const port = socket.address().port;
  await new Promise(resolveClose => socket.close(resolveClose));
  return port;
}
