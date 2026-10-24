import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { recallTaskKnowledge } from '../src/graphiti/task-knowledge-recall.js';
import { searchCurrentProjectKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { searchFederatedKnowledge } from '../src/graphiti/federated-search.js';
import { GRAPH_TOOL_DEFINITIONS } from '../src/agent-tools/graph-definitions.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const resolution = { status: 'matched', personalProjectId: 'aurora', basis: 'repository_root' };
const record = (suffix = '') => ({ id: `aurora-runbook${suffix}`, space_id: 'space', scope: 'personal',
  key: `aurora-release${suffix}`, defined_project_id: 'aurora', scope_distance: 0,
  confirmation_status: 'confirmed', score: 1, name: 'Aurora 发布流程', type: 'Runbook',
  summary: 'Required old command: npm run verify:release.\n' + '界🙂'.repeat(1800),
  source_uris: Array.from({ length: 12 }, (_, i) => `https://example.test/source/${i}?q=${'z'.repeat(500)}`),
  attributes: { final_required_step: 'Keep the exact deployment target staging-aurora.', labels: ['旧事实', '🙂'] } });

function application(items = [record()]) {
  const calls = [];
  return { calls, config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2727',
    searchKnowledge: async input => { calls.push(input); return { query: input.query, facts: [], entities: structuredClone(items) }; },
    personal: { graph: async () => ({ nodes: [], edges: [] }) } };
}

test('automatic old-context recall stays within 4 KiB while retaining useful evidence and a source', async () => {
  const app = application([record(), record('-two'), record('-three')]);
  const result = await recallTaskKnowledge(app, resolution, '沿用之前 Aurora 的发布流程');
  assert.equal(result.status, 'matched');
  assert.ok(result.entities.length > 0);
  assert.match(result.entities[0].summary, /npm run verify:release/);
  assert.ok(bytes(result) <= 4096, `Automatic recall grew to ${bytes(result)} B`);
  assert.equal(result.retrieval_budget.truncated, true);
  assert.match(result.sourceMarker.leadMarkdown, /aurora-runbook/);
  assert.ok(app.calls.every(call => call.personalProjectId === 'aurora'));
});

test('bounded on-demand pages can reconstruct an entire large Unicode record', async () => {
  const original = record();
  const app = application([original]);
  const input = { queries: ['Aurora 发布流程'], limitPerQuery: 3 };
  let cursor, fragments = '', offset = 0, pages = 0;
  do {
    const page = await searchCurrentProjectKnowledge(app, resolution, { ...input, cursor });
    assert.ok(bytes(page) <= 8 * 1024, `Search page grew to ${bytes(page)} B`);
    assert.equal(page.status, 'searched');
    const item = page.results[0].entities[0];
    assert.equal(item.id, original.id);
    assert.match(page.results[0].sourceMarker.leadMarkdown, /aurora-runbook/);
    assert.equal(item.details_fragment.offset, offset);
    fragments += item.details_fragment.text;
    offset += Array.from(item.details_fragment.text).length;
    cursor = page.next_cursor;
    if (cursor) assert.equal(page.continuation_tool, 'fuli_call');
    assert.ok(++pages < 20, 'Continuation must always advance');
  } while (cursor);
  const recovered = JSON.parse(fragments);
  assert.equal(recovered.summary, original.summary);
  assert.deepEqual(recovered.attributes, original.attributes);
  assert.deepEqual(recovered.source_uris, original.source_uris);
  assert.ok(app.calls.every(call => call.personalProjectId === 'aurora'));
});

test('continuations cannot cross a query or project and reject changed evidence', async () => {
  const items = [record()];
  const app = application(items);
  const input = { queries: ['Aurora 发布流程'], limitPerQuery: 3 };
  const page = await searchCurrentProjectKnowledge(app, resolution, input);
  assert.ok(page.next_cursor);
  await assert.rejects(searchCurrentProjectKnowledge(app, resolution,
    { ...input, queries: ['another target'], cursor: page.next_cursor }), /cursor|restart|changed/i);
  await assert.rejects(searchCurrentProjectKnowledge(app, { ...resolution, personalProjectId: 'foreign' },
    { ...input, cursor: page.next_cursor }), /cursor|restart|changed/i);
  items[0].summary = 'Changed after the first page';
  await assert.rejects(searchCurrentProjectKnowledge(app, resolution,
    { ...input, cursor: page.next_cursor }), /cursor|restart|changed/i);
});

test('a chat client continues bounded search through the existing fuli_call dispatcher', async () => {
  const app = application();
  const server = createMcpServer({ searchCurrentProjectKnowledge: input =>
    searchCurrentProjectKnowledge(app, resolution, input) },
  { env: {}, toolProfile: 'chat', registerResources: false });
  const client = new Client({ name: 'synthetic-budget-continuation', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const input = { projectPath: '/synthetic/aurora', queries: ['Aurora 发布流程'], limitPerQuery: 3 };
    const first = await client.callTool({ name: 'search_current_project_knowledge', arguments: input });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.ok(first.structuredContent.next_cursor);
    const next = await client.callTool({ name: 'fuli_call', arguments: {
      toolName: 'search_current_project_knowledge', input: { ...input, cursor: first.structuredContent.next_cursor } } });
    assert.equal(next.isError, undefined, JSON.stringify(next));
    assert.ok(next.structuredContent.results[0].entities[0].details_fragment.offset > 0);
    assert.ok(bytes(next.structuredContent) <= 8 * 1024);
  } finally { await client.close(); await server.close(); }
});

test('Agent general search is bounded while the console retains its full record', async () => {
  const original = record();
  const app = { config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2727',
    personal: { search: async () => ({ facts: [], entities: [original] }),
      graph: async () => ({ nodes: [], edges: [] }) } };
  const ports = { workspaceFor: () => assert.fail('No workspace was authorized'), recordAgentViews: async () => {} };
  const input = { personalSpaceId: 'space', personalProjectId: 'aurora', query: 'Aurora 发布流程' };
  const consoleResult = await searchFederatedKnowledge(app, input, ports);
  assert.equal(consoleResult.entities[0].summary, original.summary);
  assert.equal(consoleResult.next_cursor, undefined);
  const agent = await searchFederatedKnowledge(app, { ...input, agentInvocation: true }, ports);
  assert.ok(bytes(agent) <= 8 * 1024);
  assert.ok(agent.next_cursor);
  const next = await searchFederatedKnowledge(app, { ...input, agentInvocation: true, cursor: agent.next_cursor }, ports);
  assert.ok(next.entities[0].details_fragment.offset > 0);
});

test('read score changes do not invalidate continuation of unchanged evidence', async () => {
  const item = record();
  const app = application([item]);
  const input = { queries: ['Aurora 发布流程'], limitPerQuery: 3 };
  const first = await searchCurrentProjectKnowledge(app, resolution, input);
  item.score = 99;
  item.last_agent_viewed_at = '2026-10-18T09:45:00Z';
  const second = await searchCurrentProjectKnowledge(app, resolution, { ...input, cursor: first.next_cursor });
  assert.ok(second.results[0].entities[0].details_fragment.offset > 0);
});

test('full record fragments preserve the existing private-field omission boundary', async () => {
  const item = record();
  item.attributes.private_path = 'synthetic-private-location-must-not-leave';
  const app = application([item]);
  const input = { queries: ['Aurora 发布流程'], limitPerQuery: 3 };
  let cursor, fragments = '';
  do {
    const page = await searchCurrentProjectKnowledge(app, resolution, { ...input, cursor });
    assert.equal(JSON.stringify(page).includes('synthetic-private-location-must-not-leave'), false);
    fragments += page.results[0].entities[0].details_fragment.text;
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(JSON.parse(fragments).attributes.private_path, undefined);
});

test('multiple focused queries page every record without starving later query groups', async () => {
  const app = application();
  app.searchKnowledge = async input => ({ query: input.query, facts: [],
    entities: Array.from({ length: 12 }, (_, i) => ({ id: `${input.query}-${i}`, space_id: 'space',
      scope: 'personal', summary: `Useful old fact for ${input.query} ${i}. ` + '资料'.repeat(120) })) });
  const input = { queries: ['first', 'second', 'third', 'fourth'], limitPerQuery: 12 };
  let cursor, pages = 0;
  const seen = new Set();
  do {
    const page = await searchCurrentProjectKnowledge(app, resolution, { ...input, cursor });
    assert.ok(bytes(page) <= 8 * 1024);
    assert.equal(page.results.length, 4);
    if (!pages) assert.ok(page.results.every(group => group.entities.length), 'Every query gets its first relevant record');
    for (const group of page.results) for (const item of group.entities ?? []) {
      assert.equal(seen.has(item.id), false);
      assert.equal(item.details_fragment, undefined);
      seen.add(item.id);
    }
    cursor = page.next_cursor;
    assert.ok(++pages < 20);
  } while (cursor);
  assert.equal(seen.size, 48);
});

// The real per-query result shape: every group carries the call's scope
// fields, guidance and markers, as searchFederatedKnowledge returns them.
function federatedApplication({ recordsPerQuery = 6, projectIds = [] } = {}) {
  const app = { config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://127.0.0.1:2727',
    personal: { search: async ({ query }) => ({ facts: [], entities: Array.from({ length: recordsPerQuery }, (_, i) => ({
      id: `${query.slice(0, 12)}-${i}`, space_id: 'space', defined_project_id: 'aurora', scope_distance: 0,
      summary: `Synthetic fact ${i}. ` + '资料'.repeat(150) })) }),
    listPersonalProjects: async () => projectIds.map(project_id => ({ project_id })),
    listSubscriptions: async () => [], graph: async () => ({ nodes: [], edges: [] }) } };
  const ports = { workspaceFor: () => assert.fail('No workspace was authorized'), recordAgentViews: async () => {} };
  app.searchKnowledge = input => searchFederatedKnowledge(app, input, ports);
  return { app, ports };
}

test('a broad search at the schema maximum of queries returns records on its first page', async () => {
  const schema = GRAPH_TOOL_DEFINITIONS.find(tool => tool.name === 'search_current_project_knowledge').inputSchema;
  const { maxItems } = schema.properties.queries;
  const { maxLength } = schema.properties.queries.items;
  const { app } = federatedApplication();
  const queries = Array.from({ length: maxItems }, (_, i) => `${i}-` + '宽查询'.repeat(maxLength).slice(0, maxLength - 2));
  const input = { queries, limitPerQuery: 12 };
  const first = await searchCurrentProjectKnowledge(app, resolution, input);
  assert.ok(bytes(first) <= 8 * 1024, `First page grew to ${bytes(first)} B`);
  assert.ok(first.retrieval_budget.returned_items > 0, 'The first page carries records, not only metadata');
  assert.equal(first.retrieval_budget.total_items, maxItems * 6);
  assert.ok(first.next_cursor);
  assert.equal(first.results.length, maxItems);
  // Shared guidance and markers appear once, not once per query.
  assert.equal(first.retrievalGuidance.markerToUseIfNoSupportingEvidence, 'noMatchSourceMarker');
  assert.equal(first.noMatchSourceMarker.status, 'no_match');
  assert.deepEqual(first.searchedPersonalProjectIds, ['aurora']);
  for (const group of first.results) {
    assert.equal(group.retrievalGuidance, undefined);
    assert.equal(group.noMatchSourceMarker, undefined);
    assert.equal(group.total_items, 6);
  }
  const compact = first.results.filter(group => !group.entities);
  assert.ok(compact.length > 0);
  for (const group of compact) assert.deepEqual(Object.keys(group).sort(), ['query', 'total_items']);
  const carried = first.results.find(group => group.entities);
  assert.match(carried.sourceMarker.leadMarkdown, /knowledge/);

  // A continuation re-runs the same scoped search and still verifies it.
  await assert.rejects(searchCurrentProjectKnowledge(app, resolution,
    { ...input, queries: queries.slice(1), cursor: first.next_cursor }), /cursor|restart|changed/i);
  const seen = new Set();
  let page = first, pages = 1;
  for (;;) {
    for (const group of page.results) for (const item of group.entities ?? []) seen.add(item.id);
    if (!page.next_cursor) break;
    page = await searchCurrentProjectKnowledge(app, resolution, { ...input, cursor: page.next_cursor });
    assert.ok(bytes(page) <= 8 * 1024, `Page grew to ${bytes(page)} B`);
    assert.ok(++pages < 40, 'Continuation must always advance');
  }
  assert.equal(seen.size, maxItems * 6);
  assert.equal(page.retrieval_budget.complete, true);
});

test('a confirmed all-local search names a bounded prefix of its projects instead of failing', async () => {
  const projectIds = Array.from({ length: 300 }, (_, i) => `synthetic-registered-project-${String(i).padStart(4, '0')}`);
  const { app, ports } = federatedApplication({ projectIds });
  const input = { personalSpaceId: 'space', personalProjectScope: 'all_local_confirmed', query: 'Aurora 发布流程',
    agentInvocation: true };
  const first = await searchFederatedKnowledge(app, input, ports);
  assert.ok(bytes(first) <= 8 * 1024, `First page grew to ${bytes(first)} B`);
  assert.ok(first.entities.length > 0);
  assert.ok(first.searchedPersonalProjectIds.length > 0);
  assert.equal(first.searchedPersonalProjectIds.length + first.project_ids_omitted.searchedPersonalProjectIds, 300);
  assert.deepEqual(first.searchedPersonalProjectIds, projectIds.slice(0, first.searchedPersonalProjectIds.length));
  assert.ok(first.next_cursor);
  const next = await searchFederatedKnowledge(app, { ...input, cursor: first.next_cursor }, ports);
  assert.ok(next.entities.length > 0);
  await assert.rejects(searchFederatedKnowledge(app, { ...input, query: 'another target', cursor: first.next_cursor }, ports),
    /cursor|restart|changed/i);
});

test('exact MCP delivery keeps more than twenty small search results', async () => {
  const app = application(Array.from({ length: 30 }, (_, i) => ({ id: `small-${i}`,
    space_id: 'space', scope: 'personal', summary: `Relevant fact ${i}` })));
  const server = createMcpServer({ searchCurrentProjectKnowledge: input =>
    searchCurrentProjectKnowledge(app, resolution, input) }, { env: {}, toolProfile: 'chat', registerResources: false });
  const client = new Client({ name: 'synthetic-small-records', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'search_current_project_knowledge',
      arguments: { projectPath: '/synthetic/aurora', queries: ['Aurora'], limitPerQuery: 50 } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.results[0].entities.length, 30);
    assert.equal(result.structuredContent.truncated, undefined);
  } finally { await client.close(); await server.close(); }
});
