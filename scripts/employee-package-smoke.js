import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { installEmployeePackage } from '../src/employees/install-package.js';
import { createEmployeeFixture } from '../test-support/employee-fixture.js';

const sourceDirectory = process.argv[2];
if (!sourceDirectory) throw new TypeError('Usage: node scripts/employee-package-smoke.js <built-package-directory> [--serve]');
const root = mkdtempSync(join(tmpdir(), 'fuli-employee-smoke-'));
const runtimeConfigPath = join(root, 'host/graph-runtime.json');
installEmployeePackage({ sourceDirectory, runtimeConfigPath });
const app = createEmployeeFixture({ runtimeConfigPath });
const { server, url } = await createServer({ app, port: 0 });
const mcp = createMcpServer(app, { env: {} });
const client = new Client({ name: 'employee-package-smoke', version: '1.0.0' });
let serving = false;
async function cleanup() {
  await client.close();
  await mcp.close();
  await new Promise((resolve) => server.close(resolve));
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
try {
  if (process.argv.includes('--serve')) {
    serving = true;
    process.once('SIGINT', () => { void cleanup(); });
    process.once('SIGTERM', () => { void cleanup(); });
    console.log(`Synthetic employee UI: ${url}/project-agents`);
    console.log('Only synthetic identity/project data; real packaged Jefa runtime. No external providers or models.');
  } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const target = { templateId: 'jefa', projectPath: '/synthetic/employee-qa' };
    const call = async (tool, arguments_) => {
      const result = await client.callTool({ name: 'call_employee_tool', arguments: { ...target, tool, arguments: arguments_ } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.structuredContent;
    };
    const hire = await client.callTool({ name: 'recruit_employee', arguments: target });
    assert.notEqual(hire.isError, true, JSON.stringify(hire.content));
    const definitions = await client.callTool({ name: 'list_employee_tools', arguments: target });
    assert.ok(definitions.structuredContent.tools.some(tool => tool.name === 'prepare_session_title'));
    assert.equal((await call('read_board', {})).total, 0);
    const created = await call('create_tasks', { messageId: 'packaged-task-01', tasks: [{ title: '验收打包后的员工' }] });
    const task = created.createdWorkItems[0];
    const moved = await call('update_tasks', { requestId: 'packaged-update-01', updates: [{ id: task.id, expectedUpdatedAt: task.updatedAt, status: 'review' }] });
    assert.equal(moved.updatedWorkItems[0].status, 'review');
    assert.equal((await call('read_board', {})).total, 1);
    const titleInput = { requestId: 'packaged-title-01', sourceApplication: 'synthetic-client', sessionId: 'synthetic-session',
      workItemIds: [task.id], currentTitle: 'Synthetic temporary title', canRename: true };
    const prepared = await call('prepare_session_title', titleInput);
    assert.equal(prepared.execution, 'client_required');
    assert.equal(prepared.record.proposal.status, 'ready');
    assert.equal(prepared.record.lastAppliedTitle, undefined);
    // Synthetic native-client adapter: only this test variable is renamed.
    // This verifies protocol semantics, not a live third-party client's support.
    let syntheticNativeTitle = titleInput.currentTitle;
    assert.equal(syntheticNativeTitle, prepared.action.expectedCurrentTitle);
    syntheticNativeTitle = prepared.action.title;
    const reported = await call('report_session_title', { recordId: prepared.record.id, proposalId: prepared.record.proposal.id,
      expectedRevision: prepared.record.revision, outcome: 'applied', observedTitle: syntheticNativeTitle, receiptSource: 'synthetic-native-title-adapter' });
    assert.equal(reported.evidence, 'client_reported');
    assert.equal(reported.record.proposal.status, 'reported_applied');
    const entry = await app.employees.taskEntry({ personalProjectId: 'employee-qa', sourceApplication: 'other' });
    assert.equal(entry.status, 'ready');
    assert.equal(entry.managers[0].board.items[0].id, task.id);
    const base = `${url}/employee-workspaces/jefa/employee-qa/`;
    const html = await fetch(base).then((response) => response.text());
    assert.match(html, /name="jefa-host"/);
    const script = html.match(/<script[^>]+src="([^"]+)"/)[1];
    assert.equal((await fetch(new URL(script, base))).status, 200);
    const card = await fetch(`${base}.well-known/agent-card.json`).then((response) => response.json());
    assert.equal(card.name, 'Jefa');
    assert.ok(JSON.stringify(card).includes(`${base}a2a`));
    assert.equal((await fetch(`${url}/employee-workspaces/jefa/not-assigned/`)).status, 404);
    await app.close();
    const reopened = createEmployeeFixture({ runtimeConfigPath });
    try {
      await reopened.employees.recruit({ templateId: 'jefa', personalProjectId: 'employee-qa' });
      const board = await reopened.employees.callTool({ ...target, tool: 'read_board', arguments: {} });
      assert.equal(board.total, 1);
    } finally { await reopened.close(); }
    console.log('PASS: packaged runtime, FULI MCP CRUD/title proposal + synthetic native-client receipt, task-entry board context, same-port assets/API/A2A discovery, project isolation, and SQLite persistence.');
  }
} finally { if (!serving) await cleanup(); }
