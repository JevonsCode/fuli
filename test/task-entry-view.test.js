// rec#11 D-72: the shared task-entry view every Agent's hook and the MCP
// entry tools deliver, and the rule references it names, read through a real
// MCP client. Synthetic entries only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { codexLifecycleOutput } from '../src/agents/codex/lifecycle-hook.js';
import { openCodeLifecycleOutput } from '../src/agents/opencode/lifecycle-hook.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { entryRules } from '../src/conversations/entry-rules.js';
import { registerFuliContextResources } from '../src/mcp/context-resources.js';
import { claudeEntrySession, hookFrame, syntheticPreferences, syntheticWorkingEntry }
  from '../test-support/synthetic-large-entry.js';

const SESSION = '0b3c6f5e-2d41-4c8a-9e57-6a1f0c2d9b84';
const input = { session_id: SESSION, cwd: '/synthetic/project', prompt: 'fix the export bug' };
const entry = () => syntheticWorkingEntry({ items: syntheticPreferences(6), sessionId: SESSION });
const FRAMES = {
  claude_code: async () => hookFrame((await claudeLifecycleOutput('UserPromptSubmit', input, entry))
    .hookSpecificOutput.additionalContext),
  codex: async () => hookFrame((await codexLifecycleOutput('UserPromptSubmit', { ...input, turn_id: 'turn-1' }, entry))
    .hookSpecificOutput.additionalContext),
  opencode: async () => hookFrame((await openCodeLifecycleOutput('prompt', input, entry)).context)
};

// Every `rules` reference anywhere in a frame.
function references(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach(item => references(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['rules', 'guidance_ref', 'scope_rules'].includes(key) && typeof item === 'string') found.add(item);
      else references(item, found);
    }
  }
  return found;
}

test('every Agent and the MCP view get the same compact manager, judgment and memory view', async () => {
  const views = { mcp: compactTaskContext(await entry()) };
  for (const [agent, frame] of Object.entries(FRAMES)) views[agent] = await frame();
  const { version } = entryRules();
  for (const [agent, view] of Object.entries(views)) {
    const [manager] = view.project_management_context.managers;
    assert.deepEqual(manager.guidance, { summary: manager.guidance.summary, rules: 'fuli://rules/task-entry/manager_guidance', version }, agent);
    assert.match(manager.guidance.summary, /read_board/, agent);
    assert.ok(manager.guidance.summary.length <= 110, agent);
    assert.deepEqual(manager.board, { version: 12, total: 9, view: 'on_demand' }, agent);
    assert.equal(manager.collaboration_receipt, undefined, agent);
    assert.ok(manager.session?.sessionId, `${agent}: the title tool still names its session`);
    assert.deepEqual(view.judgment_context.guidance, { summary: view.judgment_context.guidance.summary,
      rules: 'fuli://rules/task-entry/judgment_guidance', version }, agent);
    assert.match(view.judgment_context.guidance.summary, /assess_agent_action/, agent);
    const { current } = view.project_agent_context.memory;
    for (const field of ['personalSpaceId', 'personalProjectId', 'agentId', 'revision', 'checkpointId', 'taskId', 'sourceSessionId']) {
      assert.equal(current[field], undefined, `${agent}: memory.current.${field}`);
    }
    assert.equal(view.project_agent_context.memory.revision, 7, agent);
    assert.equal(current.createdAt, '2026-10-26T10:00:00.000Z', agent);
  }
  // A hook context sends the token once; MCP results keep both fields.
  for (const agent of Object.keys(FRAMES)) assert.equal(views[agent].task_context_token, undefined, agent);
  assert.equal(views.mcp.task_context_token, views.mcp.taskContextToken);
});

test('every rule reference an entry names resolves to its own section through an MCP client', async t => {
  const server = new McpServer({ name: 'fuli-rules-test', version: '1.0.0' });
  registerFuliContextResources(server, {});
  const client = new Client({ name: 'fuli-rules-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const found = new Set();
  for (const frame of Object.values(FRAMES)) references(await frame(), found);
  await claudeEntrySession(async session => {
    const items = syntheticPreferences(31);
    for (const token of ['task-1', 'task-2']) {
      references((await session.turn(await syntheticWorkingEntry({ items, sessionId: session.sessionId, token }))).frame, found);
    }
  });
  const { sections, version } = entryRules();
  const named = [...found].map(uri => uri.replace('fuli://rules/task-entry/', ''));
  for (const section of ['task_guidance', 'application_guidance', 'manager_guidance', 'judgment_guidance', 'memory_guidance',
    'receipt_guidance', 'conversation_guidance', 'checkpoint_guidance', 'preference_delivery']) {
    assert.ok(named.includes(section), `${section} is referenced`);
  }
  for (const uri of found) {
    assert.match(uri, /^fuli:\/\/rules\/task-entry\/[a-z_]+$/);
    const section = uri.slice('fuli://rules/task-entry/'.length);
    const { contents: [resource] } = await client.readResource({ uri });
    assert.equal(resource.uri, uri);
    assert.match(resource.text, new RegExp(`version ${version}`));
    assert.ok(resource.text.includes(`## ${section}\n`), uri);
    const text = sections[section];
    for (const rule of typeof text === 'string' ? [text] : Object.values(text).filter(item => typeof item === 'string')) {
      assert.ok(resource.text.includes(rule), `${uri} holds its text`);
    }
    for (const other of Object.keys(sections).filter(name => name !== section)) {
      assert.equal(resource.text.includes(`## ${other}\n`), false, `${uri} holds only its section`);
    }
  }
  // An unknown section is the caller's argument, not a server failure.
  await assert.rejects(client.readResource({ uri: 'fuli://rules/task-entry/no_such_section' }), error => error.code === -32602);
});

test('a sealed worker keeps the full manager rules, and they name read_board', async () => {
  const value = await entry();
  const [manager] = compactTaskContext({ ...value, worker_run: { run_id: 'run-1' } }).project_management_context.managers;
  assert.equal(typeof manager.guidance, 'string');
  assert.match(manager.guidance, /read_board/);
});
