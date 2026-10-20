// Synthetic fixtures only: temporary policy files, an in-memory task registry and a
// recording Provider double. No FULI data directory, live Provider or client is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { syncConversationTranscript } from '../src/conversations/sync-transcript.js';
import { beginConversation } from '../src/graphiti/agent-conversations.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { recordProjectMemoryUsage } from '../src/graphiti/project-memory-usage.js';
import { createServer } from '../src/server.js';
import { closeServer, requestJson } from '../test-support/server.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: 'synthetic-space' } };
const LEAD = { agent_id: 'synthetic-lead', personal_space_id: 'synthetic-space',
  personal_project_id: 'synthetic-project', memory_scope: 'reviewed_agent',
  profile: { name: 'Synthetic lead', responsibility: 'Synthetic work.', status: 'active', allowed_clients: ['codex'] } };
const GRAPH = { space_id: 'synthetic-space', nodes: [{ id: 'entity-1', name: 'Synthetic' }], edges: [] };
// Provider reads that send a POST body; every other non-GET request writes.
const PROVIDER_READ_POSTS = new Set(['/v1/search', '/v1/agent-conversations/query', '/v1/project-agent-context/resolve']);
const CODEX_TRANSCRIPT = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };
// Words from a session the user chose not to record. No store or receipt may keep them.
const PRIVATE = 'synthetic-private-words';
// rec#11 D-01 receipts: automatic recording stops, explicit edits still save.
const RECORDING_OFF = '自动记录已关闭；你明确提交的修改仍会保存';
const SETTINGS_UNREADABLE = '记录设置读取失败，本次未自动记录；你明确提交的修改仍会保存';

async function fixture(t, writePolicy) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-capture-decision-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  const policyPath = capturePolicyPathForRuntime(runtimeConfigPath);
  await writePolicy(policyPath);
  const calls = [];
  const registry = new TaskContextRegistry();
  const app = new FederatedGraphApplication(CONFIG, {
    capturePolicyStore: new CapturePolicyStore(policyPath),
    taskContextRegistry: registry,
    fetchImpl: async (url, options = {}) => {
      const { pathname } = new URL(url);
      calls.push({ method: options.method ?? 'GET', path: pathname });
      if (pathname === '/v1/project-agents/synthetic-lead') return Response.json(LEAD);
      if (pathname === '/v1/search') return Response.json({ items: [] });
      if (pathname === '/v1/spaces/synthetic-space/graph') return Response.json(GRAPH);
      if (pathname === '/v1/agent-conversations/query') return Response.json({ conversation_id: 'synthetic-conversation', messages: [] });
      return Response.json([]);
    }
  });
  const task = registry.begin({ sessionId: 'synthetic-session', personalProjectId: 'synthetic-project',
    projectAgentId: 'synthetic-lead', sourceApplication: 'codex' });
  const hookInput = { session_id: 'synthetic-session', cwd: directory, prompt: `Remember ${PRIVATE}.`,
    transcript_path: join(directory, 'session.jsonl') };
  return { directory, runtimeConfigPath, app, registry, task, calls, hookInput,
    setPolicy: value => new CapturePolicyStore(policyPath).update(value),
    writes: () => calls.filter(call => call.method !== 'GET' && !PROVIDER_READ_POSTS.has(call.path)) };
}

const policyFile = value => path => new CapturePolicyStore(path).update(value);

function hook(f, event, callTool) {
  return runCodexLifecycleHook(['--event', event], {
    readInput: async () => f.hookInput, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} }),
    ...(callTool ? { callTool } : {})
  });
}

const entryContext = async () => ({ taskContextToken: 'fuli-task-synthetic-entry', effective_preferences: [] });

function knowledgeEpisode(sourceApplication) {
  return { targetKind: 'personal', spaceId: 'synthetic-space', sourceApplication,
    idempotencyKey: `synthetic-capture-${sourceApplication}`, name: 'Synthetic capture', sourceKind: 'conversation',
    sourceDescription: 'Synthetic session evidence', referenceTime: '2026-10-20T00:00:00.000Z', sensitivity: 'normal',
    entities: [{ key: 'preference:synthetic', name: 'Synthetic preference', type: 'Preference', originQuadrant: 'known_known',
      confirmationStatus: 'pending', confirmationBasis: { existenceReason: 'The user stated it.',
        quadrantReason: 'The user stated it explicitly.', proposedBy: { kind: 'agent', label: 'Codex' } } }],
    relationships: [] };
}

const disabledShape = value => ({ status: value?.status, reason: value?.reason, layer: value?.layer });

// Every write a session can trigger: raw transcript, Agent conversation, task
// checkpoint with preference evidence, knowledge capture, Agent memory, workflow
// observation and project registration.
async function everyWritePath(f) {
  const scope = { personalSpaceId: 'synthetic-space', personalProjectId: 'synthetic-project', sourceApplication: 'codex' };
  return {
    transcript: await syncConversationTranscript(f.app, f.hookInput, 'codex', CODEX_TRANSCRIPT),
    conversation: await beginConversation(f.app, f.task),
    checkpoint: await callAgentTool(f.app, 'checkpoint_task_knowledge', {
      taskContextToken: f.task.token, sourceApplication: 'codex', disposition: 'capture_candidates',
      reason: `Finished ${PRIVATE}.`, workLog: { status: 'completed', summary: `Did ${PRIVATE}.` },
      remember: [{ kind: 'preference', text: `Prefers ${PRIVATE}.`, quote: `I prefer ${PRIVATE}.` }]
    }),
    knowledge: await callAgentTool(f.app, 'capture_session_knowledge', knowledgeEpisode('codex')),
    memory: await callAgentTool(f.app, 'checkpoint_project_agent_memory', { ...scope, agentId: 'synthetic-lead',
      expectedRevision: 0, idempotencyKey: 'synthetic-memory', memory: { summary: PRIVATE } }),
    observation: await callAgentTool(f.app, 'record_workflow_transition_observation',
      { personalSpaceId: 'synthetic-space', sourceApplication: 'codex' }),
    project: await callAgentTool(f.app, 'upsert_personal_project', { personalSpaceId: 'synthetic-space',
      projectId: 'synthetic-new', profile: { name: PRIVATE }, sourceApplication: 'codex' })
  };
}

async function assertLedgerHoldsNoContent(f) {
  for (const name of await readdir(join(f.directory, 'transcript-capture'))) {
    const ledger = JSON.parse(await readFile(join(f.directory, 'transcript-capture', name), 'utf8'));
    // A pending denial is kept as its reason code only.
    assert.deepEqual(Object.keys(ledger).filter(key => key !== 'pending'), ['version', 'settings']);
    if ('pending' in ledger) assert.match(ledger.pending, /^[a-z_]+$/);
    assert.equal(JSON.stringify(ledger).includes(PRIVATE), false);
  }
}

function assertNothingKept(f, checkpoint) {
  assert.deepEqual(f.writes(), [], 'no Provider write may run while capture is off');
  const stored = f.registry.context(f.task.token, 'codex').checkpoint;
  assert.equal(stored.phase, 'complete', 'the task still closes so the Stop hook does not block');
  assert.equal(JSON.stringify(stored).includes(PRIVATE), false, 'the task record keeps no uncaptured words');
  assert.equal(JSON.stringify(checkpoint.agent_receipt).includes(PRIVATE), false);
}

for (const { name, policy, reason, layer } of [
  { name: 'the global switch', policy: { enabled: false }, reason: 'global_off', layer: 'global' },
  { name: 'the client switch', policy: { enabled: true, disabledSources: ['codex'] }, reason: 'client_off', layer: 'client' }
]) {
  test(`${name} stops every write path with the same reason`, async (t) => {
    const f = await fixture(t, policyFile(policy));
    const results = await everyWritePath(f);
    const expected = { status: 'capture_disabled', reason, layer };
    for (const [path, result] of Object.entries(results)) {
      const outcome = path === 'checkpoint' ? result.capture : result;
      assert.deepEqual(disabledShape(outcome), expected, `${path} must report the capture decision`);
    }
    assert.equal(results.checkpoint.status, 'checkpointed');
    assert.deepEqual(disabledShape(results.checkpoint.conversation), expected);
    assert.equal(results.checkpoint.capture_status, 'capture_disabled');
    assertNothingKept(f, results.checkpoint);

    const entry = await hook(f, 'UserPromptSubmit', entryContext);
    assert.match(entry.hookSpecificOutput.additionalContext, /fuli-task-synthetic-entry/);
    assert.equal(entry.systemMessage, `Fuli: ${RECORDING_OFF}`, 'every entry says recording is off');
    assert.deepEqual(await hook(f, 'Stop'), {});
    assert.deepEqual(f.writes(), []);
    assert.deepEqual((await readdir(f.directory)).filter((name) => name !== '.fuli-format.lock').sort(), ['capture-policy.json', 'capture-settings-generation.json', 'transcript-capture'],
      'no transcript guard is kept; only the content-free settings generation this session was handled under');
    await assertLedgerHoldsNoContent(f);
  });
}

test('an unreadable capture policy records nothing and still serves reads', async (t) => {
  const f = await fixture(t, path => writeFile(path, '{ not json'));
  const expected = { status: 'capture_disabled', reason: 'policy_unavailable', layer: 'policy' };
  const checkpoint = await callAgentTool(f.app, 'checkpoint_task_knowledge', {
    taskContextToken: f.task.token, sourceApplication: 'codex', disposition: 'retain_nothing',
    reason: `Nothing durable in ${PRIVATE}.`, workLog: { status: 'completed', summary: `Did ${PRIVATE}.` }
  });
  assert.equal(checkpoint.status, 'checkpointed');
  assert.deepEqual(disabledShape(checkpoint.capture), expected);
  assert.deepEqual(disabledShape(checkpoint.conversation), expected);
  assert.deepEqual(disabledShape(await callAgentTool(f.app, 'capture_session_knowledge', knowledgeEpisode('codex'))), expected);
  assertNothingKept(f, checkpoint);

  const entry = await hook(f, 'UserPromptSubmit', entryContext);
  assert.match(entry.hookSpecificOutput.additionalContext, /fuli-task-synthetic-entry/);
  assert.equal(entry.systemMessage, `Fuli: ${SETTINGS_UNREADABLE}`);
  assert.equal(entry.systemMessage.includes(PRIVATE), false);
  assert.deepEqual(f.writes(), []);
  assert.deepEqual((await readdir(f.directory)).filter((name) => name !== '.fuli-format.lock').sort(), ['capture-policy.json', 'capture-settings-generation.json', 'transcript-capture']);
  await assertLedgerHoldsNoContent(f);

  const search = await callAgentTool(f.app, 'search_knowledge_graph', { personalSpaceId: 'synthetic-space', query: 'synthetic' });
  assert.equal(search.query, 'synthetic', 'reading existing knowledge does not depend on the capture policy');
  assert.ok(Array.isArray(search.facts));
});

test('a missing policy reader is a decision, never permission to write', async () => {
  assert.deepEqual(await captureDecision({}, { sourceApplication: 'codex' }),
    { allowed: false, reason: 'policy_unavailable', layer: 'policy' });
  for (const policy of [null, { enabled: 'yes' }, { enabled: true, disabledSources: 'codex' }]) {
    assert.equal((await captureDecision({ getCapturePolicy: () => policy }, {})).reason, 'policy_unavailable');
  }
});

test('an older adapter that names only its client still gets that client decision', async (t) => {
  const f = await fixture(t, policyFile({ enabled: true, disabledSources: ['codex', 'other'] }));
  assert.deepEqual(await captureDecision(f.app, { sourceApplication: 'codex' }),
    { allowed: false, reason: 'client_off', layer: 'client' });
  assert.deepEqual(await captureDecision(f.app, { sourceApplication: 'claude_code' }),
    { allowed: true, reason: null, layer: null });
  // A write that names no client is an unknown client, as at every other FULI boundary.
  assert.equal((await captureDecision(f.app, {})).reason, 'client_off');

  assert.equal((await callAgentTool(f.app, 'capture_session_knowledge', knowledgeEpisode('codex'))).reason, 'client_off');
  assert.deepEqual(f.writes(), []);
  assert.equal((await callAgentTool(f.app, 'capture_session_knowledge', knowledgeEpisode('claude_code'))).route, 'personal');
  assert.deepEqual(f.writes().map(call => call.path), ['/v1/knowledge/commits']);
});

// A retry resends the same input; a fixed capture keeps its fingerprint stable.
const privateCheckpoint = f => ({ taskContextToken: f.task.token, sourceApplication: 'codex',
  disposition: 'capture_candidates', reason: `Finished ${PRIVATE}.`,
  workLog: { status: 'completed', summary: `Did ${PRIVATE}.` },
  capture: { ...knowledgeEpisode('codex'), name: PRIVATE } });

// dot review of #226 (P1): a retry must keep the first attempt's decision, so
// turning capture back on never records what the off period did not.
for (const { name, off, reason } of [
  { name: 'capture is turned back on', off: policyFile({ enabled: false }), reason: 'global_off' },
  { name: 'the capture settings are repaired', off: path => writeFile(path, '{ not json'), reason: 'policy_unavailable' }
]) {
  test(`a completed checkpoint retried after ${name} keeps its first no-capture decision`, async (t) => {
    const f = await fixture(t, off);
    const first = await callAgentTool(f.app, 'checkpoint_task_knowledge', privateCheckpoint(f));
    assert.equal(first.conversation.reason, reason);
    f.setPolicy({ enabled: true, disabledSources: [] });
    const replay = await callAgentTool(f.app, 'checkpoint_task_knowledge', privateCheckpoint(f));
    assert.equal(replay.replayed, true);
    assert.deepEqual(disabledShape(replay.conversation), disabledShape(first.conversation));
    assertNothingKept(f, replay);
  });

  test(`a checkpoint interrupted after preparing and retried after ${name} captures nothing`, async (t) => {
    const f = await fixture(t, off);
    const complete = f.registry.checkpoint.bind(f.registry);
    f.registry.checkpoint = () => { f.registry.checkpoint = complete; throw new Error('Synthetic crash after prepare'); };
    await assert.rejects(callAgentTool(f.app, 'checkpoint_task_knowledge', privateCheckpoint(f)), /Synthetic crash/);
    f.setPolicy({ enabled: true, disabledSources: [] });
    const retry = await callAgentTool(f.app, 'checkpoint_task_knowledge', privateCheckpoint(f));
    assert.equal(retry.status, 'checkpointed');
    assert.deepEqual(disabledShape(retry.capture), { status: 'capture_disabled', reason, layer: retry.capture.layer });
    assert.equal(retry.conversation.reason, reason);
    assertNothingKept(f, retry);
  });
}

test('a checkpoint prepared while capturing and retried after capture is turned off writes nothing new', async (t) => {
  const f = await fixture(t, policyFile({ enabled: true }));
  const complete = f.registry.checkpoint.bind(f.registry);
  f.registry.checkpoint = () => { f.registry.checkpoint = complete; throw new Error('Synthetic crash after prepare'); };
  await assert.rejects(callAgentTool(f.app, 'checkpoint_task_knowledge', privateCheckpoint(f)), /Synthetic crash/);
  f.setPolicy({ enabled: false });
  const before = f.writes().length;
  const retry = await callAgentTool(f.app, 'checkpoint_task_knowledge', privateCheckpoint(f));
  assert.equal(retry.status, 'checkpointed', 'the stored claim is resent exactly, so the retry is not a conflict');
  assert.equal(retry.capture.reason, 'global_off');
  assert.equal(retry.conversation.reason, 'global_off');
  assert.deepEqual(f.writes().slice(before), []);
});

// rec#11 D-01: when automatic recording is off, writes derived from the session
// stop (usage, Agent-reported feedback, views, resume bindings, cross-project
// usage); explicit user edits from the console and an explicit new project
// still save. A corrupt policy stops the automatic writes just as strictly.
for (const { name, policy, reason, notice } of [
  { name: 'the global switch off', policy: policyFile({ enabled: false }), reason: 'global_off', notice: RECORDING_OFF },
  { name: 'the client switch off', policy: policyFile({ enabled: true, disabledSources: ['codex'] }), reason: 'client_off', notice: RECORDING_OFF },
  { name: 'an unreadable policy', policy: path => writeFile(path, '{ not json'), reason: 'policy_unavailable', notice: SETTINGS_UNREADABLE }
]) {
  test(`with ${name}, session-derived writes stop and explicit edits still save`, async (t) => {
    const f = await fixture(t, policy);
    const item = { itemId: 'entity-1', itemKind: 'entity' };
    const usage = await callAgentTool(f.app, 'record_knowledge_usage', { personalSpaceId: 'synthetic-space',
      taskId: 'synthetic-task', sessionId: 'synthetic-session', sourceApplication: 'codex', items: [{ ...item, useKind: 'applied' }] });
    const checkpoint = await callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: f.task.token,
      sourceApplication: 'codex', disposition: 'retain_nothing', reason: 'Nothing new.',
      workLog: { status: 'completed', summary: 'Done.' }, knowledgeUsage: [{ ...item, useKind: 'applied' }] });
    const crossProject = await recordProjectMemoryUsage(f.app, { taskContextToken: f.task.token, sourceApplication: 'codex',
      targetProjectId: 'synthetic-other', channel: 'roundtable', evidenceId: 'synthetic-evidence', resultCount: 1 });
    const feedback = await callAgentTool(f.app, 'record_knowledge_feedback', { personalSpaceId: 'synthetic-space',
      taskId: 'synthetic-task', sourceApplication: 'codex', items: [{ ...item, feedbackKind: 'outdated',
        reason: 'The user said it changed.', evidenceSummary: 'Agent report.', reportedByKind: 'user' }] });
    const revision = await callAgentTool(f.app, 'revise_personal_knowledge', { personalSpaceId: 'synthetic-space',
      ...item, action: 'invalidate', reason: 'The user said it changed.', sourceApplication: 'codex' });
    const graph = await callAgentTool(f.app, 'get_knowledge_graph', { spaceId: 'synthetic-space', sourceApplication: 'codex' });
    const resumed = await callAgentTool(f.app, 'resume_agent_conversation', { taskContextToken: f.task.token,
      sourceApplication: 'codex', conversationId: 'synthetic-conversation' });

    for (const [path, result] of Object.entries({ usage, feedback, revision })) {
      assert.equal(result.status, 'capture_disabled', path);
      assert.equal(result.reason, reason, path);
      assert.equal(result.notice, notice, path);
    }
    assert.deepEqual([crossProject.recorded, crossProject.reason], [false, reason]);
    assert.equal(f.registry.context(f.task.token, 'codex').checkpoint.knowledgeUsage, undefined,
      'usage feeds preference promotion, so the checkpoint keeps none');
    assert.equal(checkpoint.knowledge_usage, undefined);
    assert.ok(checkpoint.agent_receipt.markdown.endsWith(` · ${notice}`));
    assert.equal(graph.nodes.length, 1, 'reading the graph still works');
    assert.equal(resumed.conversation_id, 'synthetic-conversation', 'resuming still reads the conversation');
    assert.equal(resumed.capture.reason, reason);
    assert.deepEqual(f.writes(), [], 'no usage, feedback, view or resume binding was written');

    const { server, url } = await createServer({ app: f.app, port: 0 });
    t.after(() => closeServer(server));
    const edit = await requestJson(`${url}/api/knowledge/entity/entity-1`, { method: 'PATCH',
      body: { personalSpaceId: 'synthetic-space', action: 'invalidate', reason: 'Outdated.' } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.deepEqual(f.writes().map(call => [call.method, call.path]), [['PATCH', '/v1/knowledge/items/entity-1']],
      'an edit the local user submits in the console still saves');

    const before = f.writes().length;
    const entry = await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: f.directory,
      taskPrompt: '新项目：合成项目', sessionId: 'synthetic-entry', sourceApplication: 'codex' });
    assert.deepEqual(f.writes().slice(before).map(call => [call.method, call.path]), [['PUT', '/v1/personal-projects']],
      'the requested project is created and nothing else is recorded');
    assert.ok(entry.agent_receipt.markdown.endsWith(` · ${notice} · 已创建项目，会话未记录`), entry.agent_receipt.markdown);
  });
}

test('one entry hook parses the capture policy file at most once', async (t) => {
  const f = await fixture(t, policyFile({ enabled: true }));
  let parses = 0;
  const app = new FederatedGraphApplication(CONFIG, { taskContextRegistry: f.registry, fetchImpl: async () => Response.json([]),
    capturePolicyStore: new CapturePolicyStore(capturePolicyPathForRuntime(f.runtimeConfigPath),
      { readText: file => { parses += 1; return readFileSync(file, 'utf8'); } }) });
  await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], { write: () => {},
    readInput: async () => ({ ...f.hookInput, session_id: 'synthetic-hook-session' }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} }) });
  assert.equal(parses, 1);
  await callAgentTool(app, 'checkpoint_task_knowledge', { taskContextToken: f.task.token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Nothing new.', workLog: { status: 'completed', summary: 'Done.' } });
  assert.equal(parses, 1, 'later decisions in the same process reuse the unchanged file');
});
