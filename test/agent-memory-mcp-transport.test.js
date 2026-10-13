import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createAgentDirectorySnapshots } from '../src/agents/directory-snapshots.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { withTaskMemorySnapshot } from '../src/graphiti/project-agent-memory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// Real MCP JSON-RPC serialization over an in-memory transport, a synthetic
// HTTP Provider double and a temp data directory only.
const SPACE = 'test-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };
const text = (length, seed) => `${seed}${'记忆边界测试'.repeat(Math.ceil(length / 6))}`.slice(0, length - 4) + '尾部标记';
const entries = (seed) => Array.from({ length: 32 }, (_, index) => text(512, `${seed}${index}-`));

// The largest profile and memory layer the Provider models accept.
function largestAgent() {
  return { agent_id: 'engineer', personal_space_id: SPACE, personal_project_id: 'sample-project', memory_scope: 'reviewed_agent',
    profile: { name: 'Engineer', display_name: '边界员工', status: 'active', allowed_clients: ['codex'],
      responsibility: text(4096, 'R'), expectations: text(4096, 'E'),
      character: { judgment: text(2048, 'J'), taste: text(2048, 'T'), personality: text(2048, 'P') },
      work_kinds: entries('W'), capabilities: entries('C'), initial_preferences: entries('I') } };
}

function memoryView(project, revision, memory) {
  return { personal_space_id: SPACE, personal_project_id: project, agent_id: 'engineer', revision,
    scope: project === null ? 'private_agent_global' : 'private_agent_project', storage: 'neo4j', history: [],
    current: revision ? { revision, agent_id: 'engineer', personal_project_id: project, created_at: '2026-10-13T08:00:00Z',
      source_application: 'codex', memory } : null };
}
const largestMemory = () => ({ summary: text(4000, 'S'),
  decisions: Array.from({ length: 12 }, (_, i) => text(1024, `D${i}-`)),
  open_threads: Array.from({ length: 12 }, (_, i) => text(1024, `O${i}-`)),
  next_actions: Array.from({ length: 12 }, (_, i) => text(1024, `N${i}-`)) });

function provider(agent, memories) {
  return async (url, options = {}) => {
    const target = new URL(url);
    if (target.pathname === '/v1/project-agents/engineer') return Response.json(agent);
    if (target.pathname === '/v1/project-agents/engineer/memory') {
      if (options.method === 'PUT') {
        const input = JSON.parse(options.body);
        memories[input.personal_project_id ?? 'global'] = memoryView(input.personal_project_id, 1, input.memory);
        return Response.json({ ...memories[input.personal_project_id ?? 'global'].current, personal_space_id: SPACE });
      }
      const project = target.searchParams.get('personal_project_id');
      return Response.json(memories[project ?? 'global'] ?? memoryView(project, 0, null));
    }
    if (target.pathname === '/v1/project-agent-context/resolve') {
      return Response.json({ status: 'ready', reason: 'project_default', match_basis: [], agent });
    }
    if (target.pathname === '/v1/collaboration-preferences') {
      return Response.json({ personal_space_id: SPACE, personal_project_id: 'sample-project',
        project_agent_id: 'engineer', conflicts: [], effective_preferences: [], agent_preferences: [] });
    }
    if (target.pathname === '/v1/personal-projects/sample-project') return Response.json({ profile: { name: 'Sample' } });
    if (target.pathname === '/v1/search') return Response.json({ facts: [], entities: [] });
    return Response.json([]);
  };
}

async function connect(app, t) {
  const server = createMcpServer(app, { env: {}, sourceApplication: 'codex', registerResources: false });
  const client = new Client({ name: 'fuli-memory-transport-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return (name, args) => client.callTool({ name, arguments: args });
}

function fixture(t, agent = largestAgent(), memories = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fuli-memory-transport-'));
  mkdirSync(join(home, 'data'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const app = new FederatedGraphApplication(config, { fetchImpl: provider(agent, memories),
    projectPathResolver: () => ({ status: 'matched', personalProjectId: 'sample-project' }) });
  app.agentSnapshots = createAgentDirectorySnapshots({ root: join(home, 'data', 'agents'), providerIdentity: config.personal.providerUrl });
  return { app, home, memories };
}
const scope = (personalProjectId = 'sample-project') => ({ personalSpaceId: SPACE, personalProjectId, agentId: 'engineer' });

test('MCP delivers the complete export of the largest valid profile and memory layer', async (t) => {
  const { app } = fixture(t, largestAgent(), { 'sample-project': memoryView('sample-project', 3, largestMemory()) });
  const call = await connect(app, t);
  const result = await call('export_project_agent_memory', scope());
  assert.equal(result.isError, undefined);
  const data = result.structuredContent;
  assert.equal(data.truncated, undefined, 'never a partial file');
  assert.ok(Buffer.byteLength(JSON.stringify(data)) > 128 * 1024, 'exceeds the generic memory budget');
  for (const tail of ['R', 'E', 'J', 'T', 'P', 'W31-', 'C31-', 'I31-', 'S', 'D11-', 'O11-', 'N11-']) {
    const field = text(tail.length > 1 ? 512 : 1024, tail);
    assert.ok(data.markdown.includes(field.slice(0, 40)), `${tail} starts`);
  }
  assert.ok(data.markdown.trimEnd().endsWith('尾部标记'), 'memory tail is present');
  assert.equal(JSON.parse(result.content[0].text).markdown, data.markdown);
});

test('MCP delivers a complete export when every bounded field uses 4-byte UTF-8 code points', async (t) => {
  // The Provider counts code points, so each one may cost four bytes after encoding.
  const wide = (length, seed) => `${seed}${'😀'.repeat(length - seed.length)}`;
  const list = (seed) => Array.from({ length: 32 }, (_, index) => wide(512, `${seed}${index}-`));
  const agent = { ...largestAgent(), profile: { ...largestAgent().profile, display_name: wide(160, 'N'),
    responsibility: wide(4096, 'R'), expectations: wide(4096, 'E'),
    character: { judgment: wide(2048, 'J'), taste: wide(2048, 'T'), personality: wide(2048, 'P') },
    work_kinds: list('W'), capabilities: list('C'), initial_preferences: list('I') } };
  const memory = { summary: wide(4000, 'S'), decisions: Array.from({ length: 12 }, (_, i) => wide(1024, `D${i}-`)),
    open_threads: Array.from({ length: 12 }, (_, i) => wide(1024, `O${i}-`)),
    next_actions: Array.from({ length: 11 }, (_, i) => wide(1024, `N${i}-`)).concat(`${wide(1020, 'Z-')}END!`) };
  const { app } = fixture(t, agent, { 'sample-project': memoryView('sample-project', 3, memory) });
  const result = await (await connect(app, t))('export_project_agent_memory', scope());
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.truncated, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) > 400 * 1024);
  assert.match(result.structuredContent.markdown, /END!\n$/);
});

test('an export that cannot be delivered completely fails explicitly; other budgets are unchanged', async (t) => {
  const huge = 'x'.repeat(600 * 1024);
  const app = { getAgentAccessPolicy: () => ({ enabled: true, updatedAt: null }),
    exportProjectAgentMemory: async () => ({ filename: 'f.md', markdown: huge }),
    getProjectAgentMemory: async () => ({ revision: 1, padding: 'y'.repeat(200 * 1024) }) };
  const call = await connect(app, t);
  const failed = await call('export_project_agent_memory', scope());
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error.message, /too large to deliver completely/);
  assert.equal(JSON.stringify(failed).includes('xxxx'), false, 'no partial Markdown');
  const read = await call('get_project_agent_memory', scope());
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent.truncated, true, 'the generic read keeps its 128 KiB truncation');
  assert.ok(Buffer.byteLength(JSON.stringify(read.structuredContent)) <= 128 * 1024);
});

test('MCP reads, memory checkpoints and task entry expose directorySnapshot status and relative path only', async (t) => {
  const agent = { ...largestAgent(), profile: { name: 'Engineer', status: 'active', allowed_clients: ['codex'], responsibility: 'Maintain.' } };
  const { app, home } = fixture(t, agent, { 'sample-project': memoryView('sample-project', 2, { summary: 'Project notes.' }) });
  const call = await connect(app, t);
  const read = (await call('get_project_agent_memory', scope())).structuredContent;
  assert.equal(read.directorySnapshot.status, 'current');
  assert.match(read.directorySnapshot.path, /^agents\/[0-9a-f]{32}\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
  assert.deepEqual(read.directorySnapshot.files.map(({ scope: layer, state }) => [layer, state]),
    [['identity', 'written'], ['project', 'written']]);

  const written = (await call('checkpoint_project_agent_memory', { ...scope(null), expectedRevision: 0,
    idempotencyKey: 'transport-checkpoint-1', memory: { summary: 'Global notes.' } })).structuredContent;
  assert.equal(written.directorySnapshot.status, 'current');
  assert.equal(written.directorySnapshot.files.at(-1).scope, 'global');

  const entry = (await call('get_collaboration_preferences', { projectPath: '/synthetic/sample-project',
    taskPrompt: 'Continue.' })).structuredContent;
  assert.equal(entry.project_agent_context.directorySnapshot.status, 'current');
  assert.deepEqual(entry.project_agent_context.directorySnapshot.files.map(file => file.scope), ['identity', 'project', 'global']);

  const everything = JSON.stringify([read, written, entry]);
  assert.equal(everything.includes(home), false, 'no absolute path');
  assert.equal(everything.includes('.fuli-snapshot'), false, 'no manifest or lock internals');
});

test('a task checkpoint stale mark survives MCP serialization while private snapshot keys stay omitted', async (t) => {
  const { app } = fixture(t);
  const stub = { getAgentAccessPolicy: () => ({ enabled: true, updatedAt: null }),
    checkpointTaskKnowledge: async () => withTaskMemorySnapshot(app, { status: 'checkpointed', personal_project_id: null,
      agent_memory: { status: 'checkpointed', agentId: 'engineer', revision: 4 }, snapshot: { private: 'raw graph' } }),
    getProjectAgentMemory: async () => ({ revision: 0, snapshot: { private: 'raw graph' }, fullSnapshot: ['raw'] }) };
  const call = await connect(stub, t);
  const response = await call('checkpoint_task_knowledge', { taskContextToken: 'synthetic-token',
    disposition: 'retain_nothing', reason: 'Synthetic.' });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const checkpoint = response.structuredContent;
  assert.equal(checkpoint.agent_memory.directorySnapshot.status, 'stale');
  assert.deepEqual(checkpoint.agent_memory.directorySnapshot.files.map(({ scope: layer, revision }) => [layer, revision]), [['global', 4]]);
  assert.equal('snapshot' in checkpoint, false);
  const read = (await call('get_project_agent_memory', scope())).structuredContent;
  assert.equal('snapshot' in read || 'fullSnapshot' in read, false, 'generic private snapshot filter is intact');
});
