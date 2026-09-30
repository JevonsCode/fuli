// Synthetic Hook subprocess acceptance, not a claim that an external model/host ran.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { callAgentTool } from '../src/agent-tools.js';
import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';

const enabled = process.env.FULI_TEST_NEO4J_EPHEMERAL === '1' && process.env.FULI_TEST_NEO4J_URI;

test('candidate Hook subprocesses persist visible history and recover only the selected Agent through real Neo4j', {
  skip: !enabled, timeout: 180_000
}, async t => {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.FULI_TEST_NEO4J_URI).hostname));
  const directory = await mkdtemp(join(tmpdir(), 'fuli-hook-acceptance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectId = 'synthetic-hook-project';
  const projectPath = join(directory, projectId);
  await mkdir(projectPath);
  const port = await freePort();
  const providerUrl = `http://127.0.0.1:${port}`;
  const bootstrapToken = 'synthetic-hook-bootstrap-123456';
  const provider = spawn(process.env.FULI_TEST_PYTHON ?? resolve('graph-provider/.venv/bin/python'), [
    '-m', 'uvicorn', 'fuli_graph.app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'error'
  ], { cwd: resolve('graph-provider'), env: {
    PATH: process.env.PATH, PYTHONUNBUFFERED: '1', FULI_PROVIDER_ID: 'hook-acceptance',
    FULI_PROVIDER_MODE: 'personal', FULI_BOOTSTRAP_TOKEN: bootstrapToken,
    FULI_NEO4J_URI: process.env.FULI_TEST_NEO4J_URI,
    FULI_NEO4J_PASSWORD: process.env.FULI_TEST_NEO4J_PASSWORD ?? 'fixture-pass'
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(provider, 'exit');
  const errors = [];
  provider.stderr.on('data', chunk => errors.push(chunk.toString()));
  t.after(async () => { provider.kill('SIGTERM'); await closed; });
  for (let attempt = 0; attempt < 400; attempt++) {
    assert.equal(provider.exitCode, null, 'Disposable Provider exited before readiness');
    try { if ((await fetch(`${providerUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* startup */ }
    if (attempt === 399) assert.fail(`Disposable Provider was not ready: ${errors.join('').slice(-2000)}`);
    await delay(100);
  }
  let accessToken;
  async function request(path, body, method = 'POST') {
    const response = await fetch(providerUrl + path, {
      method, headers: { 'content-type': 'application/json', ...(accessToken
        ? { authorization: `Bearer ${accessToken}` } : { 'x-fuli-bootstrap-token': bootstrapToken }) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000)
    });
    assert.equal(response.ok, true, `Synthetic HTTP ${response.status}: ${path}`);
    return response.json();
  }
  const principal = await request('/v1/bootstrap', { principal_name: 'Synthetic Hook acceptance' });
  accessToken = principal.access_token;
  const space = await request('/v1/spaces', { name: 'Synthetic Hook journal', kind: 'personal' });
  await request('/v1/personal-projects', { personal_space_id: space.id, project_id: projectId,
    profile: { name: 'Synthetic Hook project', lifecycle: 'active' } }, 'PUT');
  for (const [agentId, workKind, capability] of [['engineer', 'implementation', 'coding'], ['reviewer', 'code_review', 'review']]) {
    await request('/v1/project-agents', { personal_space_id: space.id, personal_project_id: projectId, agent_id: agentId,
      profile: { name: `Synthetic ${agentId}`, responsibility: 'Maintain the synthetic fixture.',
        allowed_clients: ['claude_code', 'codex'], work_kinds: [workKind], capabilities: [capability] } }, 'PUT');
  }
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  await writeFile(runtimeConfigPath, JSON.stringify({ version: 1,
    personal: { providerUrl, accessToken, principalId: principal.principal_id, spaceId: space.id }, workspaces: []
  }), { mode: 0o600 });
  const scope = { personal_space_id: space.id, personal_project_id: projectId, agent_id: 'engineer', source_application: 'claude_code' };
  const query = extra => request('/v1/agent-conversations/query', { ...scope, ...extra });
  async function hook(source, event, input) {
    const child = spawn(process.execPath, [resolve(`src/agents/${source}/lifecycle-hook.js`),
      '--runtime-config', runtimeConfigPath, '--event', event, '--timeout-ms', '25000'], {
      cwd: resolve('.'), env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const finished = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdin.end(JSON.stringify(input));
    const [code, signal] = await finished;
    clearTimeout(timer);
    assert.deepEqual({ code, signal, stderr }, { code: 0, signal: null, stderr: '' });
    return JSON.parse(output);
  }
  function context(output) {
    assert.notEqual(output.decision, 'block', JSON.stringify(output));
    const text = output.hookSpecificOutput?.additionalContext;
    assert.equal(typeof text, 'string', JSON.stringify(output));
    return JSON.parse(text.slice(text.indexOf('\n{') + 1));
  }
  const session = 'synthetic-first';
  const transcript = join(directory, 'first.jsonl');
  const prompt = 'Implement the synthetic checkpoint fixture.';
  const old = claudeRow(session, 'assistant', 'OLD_SCOPE_DO_NOT_IMPORT');
  await writeFile(transcript, old + claudeRow(session, 'user', prompt));
  assert.deepEqual(await query({ mode: 'session', session_id: session }), { conversation_id: null, cursor: 0, initialized: false });
  // No setup append: the actual candidate task-entry Hook owns begin + boundary initialization.
  const input = { session_id: session, cwd: projectPath, transcript_path: transcript, prompt };
  const first = context(await hook('claude-code', 'UserPromptSubmit', input));
  assert.equal(first.context.project_agent_id, 'engineer');
  assert.equal(first.conversation.recovery, null);
  const initialized = await query({ mode: 'session', session_id: session });
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.cursor, Buffer.byteLength(old));
  const marker = 'VISIBLE_TRANSCRIPT_SYNTHETIC_MARKER';
  await appendFile(transcript, claudeRow(session, 'assistant', [
    { type: 'thinking', thinking: 'PRIVATE_THINKING_NOT_CAPTURED' }, { type: 'text', text: marker }
  ]));
  const stop = await hook('claude-code', 'Stop', { session_id: session, cwd: projectPath, transcript_path: transcript });
  assert.equal(stop.decision, 'block', 'first Stop asks for the genuine task checkpoint');
  const saved = await query({ mode: 'events', conversation_id: initialized.conversation_id });
  assert.ok(saved.events.some(event => event.content === marker));
  assert.equal(saved.events.filter(event => event.role === 'user' && event.content === prompt).length, 1,
    'task entry and the native collector must not duplicate the user prompt');
  assert.doesNotMatch(JSON.stringify(saved.events), /OLD_SCOPE_DO_NOT_IMPORT|PRIVATE_THINKING_NOT_CAPTURED/);
  // Explicit synthetic checkpoint, with no model call and no fabricated completion from the Hook.
  const application = openFederatedGraphApplication({ runtimeConfigPath });
  try {
    const checkpoint = await callAgentTool(application, 'checkpoint_task_knowledge', {
      taskContextToken: first.task_context_token, disposition: 'retain_nothing',
      reason: 'Synthetic acceptance only.', workLog: { status: 'completed', summary: 'Synthetic Hook flow verified.' },
      agentMemory: { expectedRevision: 0, memory: { summary: 'SYNTHETIC_DURABLE_MEMORY_MARKER' } },
      sourceApplication: 'claude_code', sourceSessionId: session
    });
    assert.equal(checkpoint.agent_memory.revision, 1);
  } finally { await application.close(); }
  assert.deepEqual(await hook('claude-code', 'Stop', { session_id: session, cwd: projectPath, transcript_path: transcript }), {});
  // A different host format + new chat selects the same role and restores both layers.
  const codexSession = 'synthetic-second';
  const codexPath = join(directory, 'second.jsonl');
  const nextPrompt = 'Implement the next synthetic change.';
  await writeFile(codexPath, JSON.stringify({ type: 'session_meta', payload: { id: codexSession } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: nextPrompt }] } }) + '\n');
  const next = context(await hook('codex', 'UserPromptSubmit', { session_id: codexSession,
    turn_id: 'turn-two', cwd: projectPath, transcript_path: codexPath, prompt: nextPrompt }));
  assert.equal(next.context.project_agent_id, 'engineer');
  assert.ok(next.conversation.recovery.messages.some(message => message.content === marker));
  assert.equal(next.project_agent_context.memory.current.memory.summary, 'SYNTHETIC_DURABLE_MEMORY_MARKER');
  const reviewSession = 'synthetic-review';
  const reviewPath = join(directory, 'review.jsonl');
  const reviewPrompt = 'Code review the synthetic component.';
  await writeFile(reviewPath, claudeRow(reviewSession, 'user', reviewPrompt));
  const reviewer = context(await hook('claude-code', 'UserPromptSubmit', { session_id: reviewSession,
    cwd: projectPath, transcript_path: reviewPath, prompt: reviewPrompt }));
  assert.equal(reviewer.context.project_agent_id, 'reviewer');
  assert.equal(reviewer.conversation.recovery, null);
  assert.equal(reviewer.project_agent_context.memory.revision, 0);
  assert.doesNotMatch(JSON.stringify(reviewer), /VISIBLE_TRANSCRIPT_SYNTHETIC_MARKER|SYNTHETIC_DURABLE_MEMORY_MARKER/);
  // Disable this Agent's capture through the real Provider, then exercise another Hook pair.
  await request('/v1/agent-conversations/policy', { ...scope, policy: { idle_days: 7, context_budget: 2000, enabled: false } }, 'PUT');
  const beforeDisabled = await query({ mode: 'list' });
  const disabledSession = 'synthetic-disabled';
  const disabledPath = join(directory, 'disabled.jsonl');
  const disabledPrompt = 'Implement the disabled capture fixture.';
  await writeFile(disabledPath, claudeRow(disabledSession, 'user', disabledPrompt));
  const disabledInput = { session_id: disabledSession, cwd: projectPath, transcript_path: disabledPath };
  const disabled = context(await hook('claude-code', 'UserPromptSubmit', { ...disabledInput, prompt: disabledPrompt }));
  assert.equal(disabled.conversation.status, 'capture_disabled');
  await appendFile(disabledPath, claudeRow(disabledSession, 'assistant', 'DISABLED_NOT_CAPTURED'));
  await hook('claude-code', 'Stop', disabledInput);
  assert.deepEqual(await query({ mode: 'list' }), beforeDisabled);
  assert.deepEqual(await query({ mode: 'session', session_id: disabledSession }), { conversation_id: null, cursor: 0, initialized: false });
  assert.equal(errors.join('').includes('Traceback'), false);
});

function claudeRow(sessionId, type, content) {
  return JSON.stringify({ sessionId, type, message: { role: type, content } }) + '\n';
}
async function freePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
