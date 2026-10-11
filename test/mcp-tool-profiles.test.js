import assert from 'node:assert/strict';
import test from 'node:test';

import { listAgentTools } from '../src/agent-tools.js';
import { clientConnectionConfig } from '../src/setup/client-connection.js';
import { toolNamesForProfile } from '../src/mcp/tool-profiles.js';

const schemaBytes = (tools) => Buffer.byteLength(JSON.stringify(tools.map(({ name, title, description, inputSchema }) =>
  ({ name, title, description, inputSchema }))));

test('the chat profile is a small subset of real tools that keeps memory and Roundtable', () => {
  const all = listAgentTools();
  const chat = toolNamesForProfile('chat');
  const known = new Set(all.map(({ name }) => name));
  assert.deepEqual(chat.filter((name) => !known.has(name)), []);
  for (const name of ['get_collaboration_preferences', 'search_current_project_knowledge', 'checkpoint_task_knowledge', 'message_agent']) {
    assert.ok(chat.includes(name), name);
  }
  const chatTools = all.filter(({ name }) => chat.includes(name));
  assert.ok(schemaBytes(chatTools) < schemaBytes(all) / 3, 'chat profile should be under a third of the full schema');
  assert.equal(toolNamesForProfile('full'), null);
  assert.throws(() => toolNamesForProfile('tiny'), /Unknown MCP tool profile/);
});

test('connect prints the requested profile and source application', () => {
  const paths = { nodePath: '/node', mcpServerPath: '/fuli/src/mcp-server.js', runtimeConfigPath: '/data/graph-runtime.json' };
  assert.deepEqual(clientConnectionConfig(paths, 'server').args,
    ['/fuli/src/mcp-server.js', '--runtime-config', '/data/graph-runtime.json', '--source-application', 'other']);
  assert.deepEqual(clientConnectionConfig(paths, 'server', { profile: 'chat', sourceApplication: 'claude' }).args,
    ['/fuli/src/mcp-server.js', '--runtime-config', '/data/graph-runtime.json', '--source-application', 'claude', '--tool-profile', 'chat']);
  assert.throws(() => clientConnectionConfig(paths, 'server', { profile: 'tiny' }), /Unknown MCP tool profile/);
  assert.throws(() => clientConnectionConfig(paths, 'server', { sourceApplication: 'desktop' }), /Unsupported MCP source application/);
});
