// Synthetic fixtures only: temporary policy files, an in-memory task registry and a
// recording Provider double. No FULI data directory, live Provider or client is used.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { syncConversationTranscript } from '../src/conversations/sync-transcript.js';
import { beginConversation } from '../src/graphiti/agent-conversations.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: 'synthetic-space' } };
const LEAD = { agent_id: 'synthetic-lead', personal_space_id: 'synthetic-space',
  personal_project_id: 'synthetic-project', memory_scope: 'reviewed_agent',
  profile: { name: 'Synthetic lead', responsibility: 'Synthetic work.', status: 'active', allowed_clients: ['codex'] } };
const CODEX_TRANSCRIPT = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };
// Words from a session the user chose not to record. No store or receipt may keep them.
const PRIVATE = 'synthetic-private-words';

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
      return Response.json([]);
    }
  });
  const task = registry.begin({ sessionId: 'synthetic-session', personalProjectId: 'synthetic-project',
    projectAgentId: 'synthetic-lead', sourceApplication: 'codex' });
  const hookInput = { session_id: 'synthetic-session', cwd: directory, prompt: `Remember ${PRIVATE}.`,
    transcript_path: join(directory, 'session.jsonl') };
  return { directory, runtimeConfigPath, app, registry, task, calls, hookInput,
    writes: () => calls.filter(call => call.method !== 'GET') };
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
    assert.deepEqual(await hook(f, 'Stop'), {});
    assert.deepEqual(f.writes(), []);
    assert.deepEqual(await readdir(f.directory), ['capture-policy.json'], 'no transcript guard is kept either');
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
  assert.match(entry.systemMessage, /capture settings could not be read/i);
  assert.equal(entry.systemMessage.includes(PRIVATE), false);
  assert.deepEqual(f.writes(), []);
  assert.deepEqual((await readdir(f.directory)).sort(), ['capture-policy.json']);

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
