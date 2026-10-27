import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { connectMcp } from '../test-support/mcp-client.js';
import { realTaskContextProvider } from '../test-support/real-task-context-provider.js';
import { listenFetchableServer } from '../src/server/listen.js';

const enabled = process.env.FULI_TEST_NEO4J_EPHEMERAL === '1' && process.env.FULI_TEST_NEO4J_URI;

test('real Neo4j + HTTP Provider + independent MCP hosts retain one role across client switches', {
  skip: !enabled, timeout: 180_000
}, async (t) => {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.FULI_TEST_NEO4J_URI).hostname));
  const directory = mkdtempSync(join(tmpdir(), 'fuli-role-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectId = 'synthetic-role-project';
  const projectPath = join(directory, projectId);
  mkdirSync(projectPath);
  const port = await freePort();
  const providerUrl = `http://127.0.0.1:${port}`;
  const bootstrapToken = 'synthetic-mcp-bootstrap-123456';
  const processHandle = spawn(process.env.FULI_TEST_PYTHON ?? resolve('graph-provider/.venv/bin/python'), [
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
    profile: { name: 'Synthetic role project', lifecycle: 'active',
      purpose: 'Verify one synthetic role across MCP client switches.' }
  }, { token, method: 'PUT' });
  for (const [agentId, workKind, capability] of [
    ['engineer', 'implementation', 'coding'], ['reviewer', 'code_review', 'review'],
    ['backup-engineer', 'implementation', 'coding']
  ]) {
    await request('/v1/project-agents', {
      personal_space_id: space.id, personal_project_id: projectId, agent_id: agentId,
      occupation: { role: 'engineering' },
      profile: { name: `Synthetic ${agentId}`, display_name: `Synthetic ${agentId}`, responsibility: 'Maintain the synthetic sample.',
        character: { judgment: 'Check evidence.', taste: 'Clear writing.', personality: 'Patient.' },
        expectations: 'Preserve confirmed preferences.',
        allowed_clients: ['codex', 'claude', 'claude_code', 'cursor'], work_kinds: [workKind], capabilities: [capability] }
    }, { token, method: 'PUT' });
  }
  await request('/v1/project-agent-coordination-policy', {
    personal_space_id: space.id, personal_project_id: projectId,
    ask_before_recruitment: false, auto_reuse_previous_agent: true, auto_grow_team: false,
    team_lead_agent_id: 'engineer', team_member_agent_ids: ['reviewer', 'backup-engineer']
  }, { token, method: 'PUT' });
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({ version: 1,
    personal: { providerUrl, accessToken: token, principalId: principal.principal_id, spaceId: space.id },
    workspaces: []
  }), { mode: 0o600 });
  let revision = 0;
  let conversationId;
  // "Synthetic engineer" reads as a job title, so the Provider gives the new Agent a
  // person name; the role stays in profile.name. Both must hold across client switches.
  let personName;
  for (const sourceApplication of ['codex', 'claude', 'claude_code', 'cursor']) {
    const connection = await connectMcp(runtimeConfigPath, { sourceApplication });
    const sessionId = `synthetic-${sourceApplication}-session`;
    let tokenForTask;
    try {
      const begun = await connection.client.callTool({ name: 'begin_task_context', arguments: {
        sessionId, turnId: 'synthetic-turn-one', projectPath, taskPrompt: '@Synthetic engineer Implement the synthetic service.',
        workKind: 'implementation', requiredCapabilities: ['coding']
      } });
      assert.equal(begun.isError, undefined, JSON.stringify(begun));
      const value = begun.structuredContent;
      assert.equal(value.context.project_agent_id, 'engineer');
      assert.equal(value.project_agent_context.status, 'ready');
      assert.equal(value.project_agent_context.worker_started, false);
      // The entry receipt only carries what is copied; owner details stay on the checkpoint receipt.
      assert.match(value.agent_receipt.markdown, /\\\[Synthetic engineer\\\]/);
      personName ??= value.project_agent_context.role.displayName;
      assert.ok(personName, JSON.stringify(value.project_agent_context.role));
      assert.doesNotMatch(personName, /engineer/i);
      assert.equal(value.project_agent_context.role.displayName, personName);
      assert.equal(value.project_agent_context.role.name, 'Synthetic engineer');
      assert.equal(value.project_agent_context.role.responsibility, 'Maintain the synthetic sample.');
      assert.equal(value.project_agent_context.role.character.taste, 'Clear writing.');
      assert.equal(value.project_agent_context.role.expectations, 'Preserve confirmed preferences.');
      assert.equal(value.project_agent_context.memory.revision, revision);
      if (revision) assert.equal(value.project_agent_context.memory.current.memory.summary, `Synthetic milestone ${revision}.`);
      tokenForTask = value.task_context_token;
      if (conversationId) {
        const continued = await connection.client.callTool({ name: 'resume_agent_conversation', arguments: {
          taskContextToken: tokenForTask, conversationId
        } });
        assert.equal(continued.isError, undefined, JSON.stringify(continued));
        assert.equal(continued.structuredContent.conversation_id, conversationId);
        // The latest result is the current checkpoint, separate from historical excerpts.
        assert.deepEqual(continued.structuredContent.context.latest_checkpoint,
          { status: 'completed', summary: `Synthetic milestone ${revision}.`, truncated: false });
        assert.equal(continued.structuredContent.context.summary_role, 'historical');
      }
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
      assert.equal(fallback.isError, undefined, JSON.stringify(fallback));
      assert.notEqual(fallback.structuredContent.taskContextToken, tokenForTask);
      assert.equal(fallback.structuredContent.previous_checkpoint_missing, true);
      tokenForTask = fallback.structuredContent.taskContextToken;
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
        workLog: { status: 'completed', summary: `Synthetic milestone ${revision + 1}.` },
        agentMemory: { expectedRevision: revision, memory: {
          summary: `Synthetic milestone ${revision + 1}.`, nextActions: ['Continue the same role in the next host.']
        } }
      } });
      assert.equal(saved.isError, undefined, JSON.stringify(saved));
      assert.equal(saved.structuredContent.agent_memory.revision, ++revision);
      assert.equal(saved.structuredContent.agent_memory.sourceApplication, sourceApplication);
      const receipt = saved.structuredContent.conversation.receipt;
      assert.equal(receipt.owner.name, personName);
      assert.match(receipt.markdown, /\\\[Synthetic engineer\\\]/);
      const savedId = saved.structuredContent.conversation.conversation_id;
      if (conversationId) assert.equal(savedId, conversationId);
      conversationId = savedId;
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
  await listenFetchableServer(socket, 0);
  const port = socket.address().port;
  await new Promise(resolveClose => socket.close(resolveClose));
  return port;
}

test('real scoped checkpoint candidates require synthetic human confirmation before another MCP client recalls them', {
  skip: !enabled, timeout: 120_000
}, async t => {
  const fixture = await realTaskContextProvider(t);
  const directory = mkdtempSync(join(tmpdir(), 'fuli-scoped-capture-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify(fixture.config), { mode: 0o600 });
  const spaceId = fixture.context.personal_space_id, projectId = fixture.context.personal_project_id;
  await fixture.request('/v1/personal-projects', { personal_space_id: spaceId, project_id: 'other-project',
    profile: { name: 'Synthetic unrelated project', lifecycle: 'active',
      purpose: 'Stay apart from the synthetic scoped capture.' } }, 'PUT');
  const episode = (key, preference) => ({ idempotencyKey: key, name: key,
    sourceKind: 'synthetic_acceptance_fixture', sourceDescription: 'Synthetic proposal, not a real user preference or project fact.',
    sourceExcerpt: preference ? 'Synthetic user explicitly requests this preference across all projects.' : 'Synthetic project-local fact.',
    referenceTime: '2026-10-16T00:00:00.000Z', entities: [{ key, name: `RoutingFixtureScope ${key}`,
      type: preference ? 'PersonalPreference' : 'ProjectKnowledge', summary: `RoutingFixtureScope ${key}`,
      originQuadrant: 'known_known', confirmationStatus: 'pending', profileAspect: preference ? 'taste' : null,
      confirmationBasis: { existenceReason: 'Synthetic fixture observation.', quadrantReason: 'Explicit synthetic test input.',
        proposedBy: { kind: 'agent', label: 'Synthetic MCP client' } },
      attributes: preference ? { preferenceKey: key, instruction: `RoutingFixtureScope ${key}` } : {} }], relationships: [] });
  const globalCapture = episode('global-preference', true), projectCapture = episode('project-fact', false);
  const input = { taskContextToken: fixture.context.token, disposition: 'capture_candidates',
    reason: 'Retain two synthetic pending candidates in their explicit scopes.',
    agentMemory: { expectedRevision: 0, memory: { summary: 'Synthetic scoped capture milestone.' } },
    workLog: { status: 'completed', summary: 'Synthetic scoped review completed.' },
    capture: { ...globalCapture, entities: [...globalCapture.entities, ...projectCapture.entities] }, captureRouting: [
      { scope: 'personal_global', entityKeys: ['global-preference'], relationshipKeys: [] },
      { scope: 'current_project', entityKeys: ['project-fact'], relationshipKeys: [], sourceExcerpt: projectCapture.sourceExcerpt }
    ] };
  const call = async (connection, name, args) => {
    const result = await connection.client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  let receipts;
  const initialMemory = await fixture.memory();
  const writer = await connectMcp(runtimeConfigPath, { sourceApplication: 'codex' });
  try {
    for (const invalidKind of ['attributes', 'inheritance']) {
      const invalid = structuredClone(input);
      const entity = invalid.capture.entities[0];
      if (invalidKind === 'attributes') entity.attributes = Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`synthetic${index}`, 'fixture']));
      else { entity.inheritanceMode = 'selected_projects'; entity.inheritedProjectIds = []; }
      const rejected = await writer.client.callTool({ name: 'checkpoint_task_knowledge', arguments: invalid });
      assert.equal(rejected.isError, true, `Provider must reject invalid ${invalidKind}`);
      assert.match(JSON.stringify(rejected), invalidKind === 'attributes' ? /at most 32 attributes/ : /selected_projects/);
      const context = await fixture.request(`/v1/task-contexts/${fixture.context.token}?${new URLSearchParams({
        personal_space_id: spaceId, source_application: 'codex' })}`, undefined, 'GET');
      assert.equal(context.checkpoint, null, 'invalid later scope must not prepare or bind a fingerprint');
      const memory = await fixture.memory();
      assert.equal(memory.revision, 0, 'invalid later scope must not advance private memory');
      assert.deepEqual(memory.work_log, initialMemory.work_log,
        'the initial running task remains without a submitted work log');
      const graph = await call(writer, 'search_knowledge_graph', { personalSpaceId: spaceId,
        personalProjectId: projectId, query: 'RoutingFixtureScope', includePending: true, limit: 20 });
      const pending = JSON.stringify(graph);
      assert.equal(pending.includes('global-preference') || pending.includes('project-fact'), false,
        'neither scope may commit before all Provider models validate');
    }
    const saved = await call(writer, 'checkpoint_task_knowledge', input);
    receipts = saved.capture_results;
    assert.equal(saved.agent_memory.revision, 1);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every(item => item.status === 'committed' && item.episode_id && item.review_paths.length));
  } finally { await writer.close(); }
  const globalId = receipts.find(item => item.scope === 'personal_global').entity_ids[0];
  const projectIdForFact = receipts.find(item => item.scope === 'current_project').entity_ids[0];
  const reader = await connectMcp(runtimeConfigPath, { sourceApplication: 'claude' });
  try {
    const search = (personalProjectId, includePending = false) => call(reader, 'search_knowledge_graph', {
      personalSpaceId: spaceId, personalProjectId, query: 'RoutingFixtureScope', includePending, limit: 20 });
    const hidden = JSON.stringify(await search(projectId));
    assert.equal(hidden.includes(globalId) || hidden.includes(projectIdForFact), false);
    const pending = JSON.stringify(await search(projectId, true));
    assert.ok(pending.includes(globalId) && pending.includes(projectIdForFact), 'pending IDs must exist in the real graph');
    const preferences = await call(reader, 'get_collaboration_preferences', { projectPath: directory, personalProjectId: projectId });
    assert.equal(preferences.effective_preferences.some(item => item.preference_key === 'global-preference'), false);
    // This is synthetic human input through the same Provider operation used
    // by KnowledgeConfirmDialog. It is not a real human approval or model run.
    for (const [id, scopeProject] of [[globalId, null], [projectIdForFact, projectId]]) {
      await fixture.request(`/v1/knowledge/items/${id}`, { personal_space_id: spaceId,
        personal_project_id: scopeProject, item_kind: 'entity', action: 'confirm', operation_actor: 'human',
        reason: 'Synthetic human fixture confirmation.', confirmation_status: 'confirmed',
        confirmation_basis: { existence_reason: 'Synthetic fixture evidence.', quadrant_reason: 'Explicit test data.',
          proposed_by: { kind: 'agent', label: 'Synthetic MCP client' },
          confirmed_by: { kind: 'user', label: 'Synthetic human fixture' }, confirmed_at: '2026-10-16T00:00:01Z' } }, 'PATCH');
    }
    const confirmed = JSON.stringify(await search(projectId));
    assert.ok(confirmed.includes(globalId) && confirmed.includes(projectIdForFact));
    const otherProject = JSON.stringify(await search('other-project'));
    assert.ok(otherProject.includes(globalId));
    assert.equal(otherProject.includes(projectIdForFact), false, 'project knowledge must not become global');
    const applied = await call(reader, 'get_collaboration_preferences', { projectPath: directory, personalProjectId: projectId });
    assert.ok(applied.effective_preferences.some(item => item.preference_key === 'global-preference'
      && item.preference_scope === 'global' && item.confirmation_status === 'confirmed'),
    JSON.stringify(applied.effective_preferences));
    const foreign = await reader.client.callTool({ name: 'checkpoint_task_knowledge', arguments: input });
    assert.equal(foreign.isError, true, 'another client cannot reuse the writer task token');
  } finally { await reader.close(); }
  const replay = await connectMcp(runtimeConfigPath, { sourceApplication: 'codex' });
  try {
    const saved = await call(replay, 'checkpoint_task_knowledge', input);
    assert.equal(saved.replayed, true);
    assert.deepEqual(saved.capture_results, receipts);
    assert.equal((await fixture.memory()).revision, 1, 'receipt replay must not advance private memory twice');
  } finally { await replay.close(); }
});
