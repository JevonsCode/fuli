import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { readTaskPreferences } from '../src/graphiti/task-preference-reader.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { joinHost } from '../src/runner/join.js';
import { encodeInvitation, newInvitationCode } from '../src/runner/protocol.js';
import { runRunnerMcp } from '../src/runner/runner-mcp.js';

// Whether a real host lets a runner read a task's whole preferences the way the
// runner's own read does (runner-mcp.js readHostPreferences): fuli_call to
// read_task_preferences in the chat profile, over the paired channel, in the
// client's own session. The host side is the real one: its runner routes, the
// MCP server they create for a runner session (create-mcp-server.js) and the
// reader with its session, client and token checks (task-preference-reader.js),
// over a made-up task as test/task-preference-reader.test.js builds one.
const SESSION = '019fc6ed-02a5-7832-8821-68e3b03e7cef';

test('a runner\'s chat client reads a task\'s whole preferences from a real host in its own session', async (t) => {
  const f = readerApp(75);
  const runner = await pairedRunner(t, f.app, { env: { CODEX_THREAD_ID: SESSION } });
  const read = await runner.client.callTool({ name: 'fuli_call',
    arguments: { toolName: 'read_task_preferences', input: { taskContextToken: f.task.token } } });
  assert.notEqual(read.isError, true, read.content?.[0]?.text);
  const value = read.structuredContent;
  assert.equal(value.context.session_id, SESSION, 'read in the session that entered the task');
  assert.ok(['complete', 'paginated'].includes(value.preference_delivery?.status ?? 'complete'), JSON.stringify(value.preference_delivery));
  assert.ok(value.effective_preferences.length > 0);
  assert.equal(f.reads(), 1, 'the host read it once, as the owner of the task');
});

test('the host refuses the same read from a runner session that is not the task\'s', async (t) => {
  const f = readerApp(5);
  const runner = await pairedRunner(t, f.app, { env: { CODEX_THREAD_ID: '019fc6ed-02a5-7832-8821-000000000000' } });
  const read = await runner.client.callTool({ name: 'fuli_call',
    arguments: { toolName: 'read_task_preferences', input: { taskContextToken: f.task.token } } });
  assert.equal(read.isError, true, 'another session cannot read this task\'s preferences');
});

test('a runner\'s chat client gets the host\'s bounded entry and reads every preference it left out', async (t) => {
  const f = readerApp(75);
  f.app.getCollaborationPreferences = async () => ({ effective_preferences: structuredClone(f.items),
    taskContextToken: f.task.token, task_context_token: f.task.token, checkpoint_required: false,
    context: { personal_space_id: 'space-a', personal_project_id: 'project-a', project_agent_id: 'agent-a' } });
  const runner = await pairedRunner(t, f.app, { env: { CODEX_THREAD_ID: SESSION } });
  const entry = await runner.client.callTool({ name: 'get_collaboration_preferences',
    arguments: { projectPath: realpathSync(tmpdir()), taskPrompt: 'a synthetic request', sessionId: SESSION } });
  assert.notEqual(entry.isError, true, entry.content?.[0]?.text);
  const frame = entry.structuredContent;
  assert.ok(frame.effective_preferences.length < 75 && frame.preferences_omitted.count === 75 - frame.effective_preferences.length);
  const keys = frame.effective_preferences.map((item) => item.preference_key);
  const all = [];
  let cursor;
  do {
    const read = await runner.client.callTool({ name: 'fuli_call', arguments: { toolName: 'read_task_preferences',
      input: { ...frame.preferences_omitted.read.arguments, ...(cursor ? { cursor } : {}) } } });
    assert.notEqual(read.isError, true, read.content?.[0]?.text);
    all.push(...read.structuredContent.effective_preferences.map((item) => item.preference_key));
    cursor = read.structuredContent.preference_delivery?.next_cursor;
  } while (cursor);
  assert.deepEqual(all.sort(), f.items.map((item) => item.preference_key).sort());
  assert.ok(keys.every((key) => all.includes(key)));
});

// A made-up task and its preferences, as the Provider answers them (count rules).
function readerApp(count) {
  const task = { token: 'fuli-task-synthetic-runner-read', sessionId: SESSION, sourceApplication: 'codex',
    sourceSessionId: null, personalProjectId: 'project-a', projectAgentId: 'agent-a',
    preferenceScope: { version: 1, work_kind: 'implementation', workflow: 'release' }, checkpoint: null,
    agentAssignment: { version: 1, selection_reason: 'delegated_member', match_basis: ['A member worker reports to its lead.'],
      requested_agent_id: null, reporting_lead_agent_id: 'lead-a', execution_reason: null, execution_agent_id: null } };
  const items = Array.from({ length: count }, (_, index) => ({ id: `rule-${index}`, item_kind: 'entity',
    instruction: `规则${index}：${'改动要小，说清检查了什么。'.repeat(14)}`, preference_key: `rule-${index}`,
    preference_scope: 'project', preference_project_id: 'project-a', confirmation_status: 'confirmed',
    preference_qualifiers: { workKind: 'implementation', workflow: 'release' } }));
  const preferences = { personal_space_id: 'space-a', personal_project_id: 'project-a', project_agent_id: 'agent-a',
    effective_preferences: items, global_preferences: [], project_preferences: items, agent_preferences: [],
    conflicts: [], queued_conflicts: [], truncated: false, task_scope_filtered: true,
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } };
  const agent = { agent_id: 'agent-a', profile: { name: 'Example owner', responsibility: 'Owns the example.',
    status: 'active', allowed_clients: ['codex'] } };
  const team = { policy: { team_lead_agent_id: 'lead-a', team_member_agent_ids: ['agent-a'] }, agents: [
    { agent_id: 'lead-a', profile: { name: 'Lead', status: 'active' }, assignments: [{ personal_project_id: 'project-a', status: 'active' }] },
    { ...agent, assignments: [{ personal_project_id: 'project-a', status: 'active' }] }] };
  let reads = 0;
  const owned = (token, sourceApplication) => token === task.token && sourceApplication === task.sourceApplication;
  const notFound = () => new ProviderRequestError('Task context not found', { status: 404 });
  const app = { config: { personal: { spaceId: 'space-a' } },
    taskContextRegistry: {
      preferences: async (token, input) => {
        if (!owned(token, input.sourceApplication) || input.sessionId !== task.sessionId) throw notFound();
        reads += 1;
        return { task: structuredClone(task), preferences: structuredClone(preferences) };
      },
      context: async (token, sourceApplication) => {
        if (!owned(token, sourceApplication)) throw notFound();
        return structuredClone(task);
      },
      currentTaskSession: async (token, sourceApplication) => (owned(token, sourceApplication) ? task.sessionId : null)
    },
    personal: { getProjectAgent: async () => structuredClone(agent),
      getProjectAgentCoordinationPolicy: async () => structuredClone(team.policy),
      listProjectAgents: async () => structuredClone(team.agents),
      getPersonalProject: async () => ({ profile: { name: 'Example', purpose: 'An example.', boundaries: [] } }) },
    judgment: { policy: async () => ({ mode: 'manual', client: 'codex', revision: 1 }) }
  };
  app.readTaskPreferences = (input) => readTaskPreferences(app, input);
  return { app, task, items, reads: () => reads };
}

// A runner paired with a real host listener whose routes create the host's real
// MCP server for each runner session; client: one of the runner's MCP clients (chat profile).
async function pairedRunner(t, app, { env }) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-read-')));
  const host = deviceIdentity(await createDeviceCertificate());
  const store = new RunnerHostStore(':memory:');
  const routes = createRunnerRoutes({ app, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation() });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    isPairedDevice: (fingerprint) => store.isPaired(fingerprint), route: routes.handle });
  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const dataDir = path.join(base, 'runner-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port: listener.port,
    certPem: host.certPem, code }) });
  const client = new Client({ name: 'codex', version: 'test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runRunnerMcp({ dataDir, sourceApplication: 'codex', toolProfile: 'chat', env, transport: serverSide,
    lookUp: async () => [], retryAfterMs: 0 });
  await client.connect(clientSide);
  // In this order, the folder last: Windows refuses to delete a SQLite file that is still open.
  t.after(async () => {
    await client.close();
    await served.close();
    await listener.close();
    await routes.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { client };
}
