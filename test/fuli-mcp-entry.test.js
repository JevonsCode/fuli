import assert from 'node:assert/strict';
import test from 'node:test';

import { fuliMcpServerEntry } from '../src/agent-kits/fuli-mcp-entry.js';
import { loadClientDescriptorPacks } from '../src/setup/agents/descriptor-packs.js';

// Synthetic paths; the bundled descriptor packs are what agent-installer writes from.
const paths = { dataDir: '/synthetic/data', clientNodePath: '/synthetic/bin/node', mcpServerPath: '/synthetic/fuli/src/mcp-server.js',
  graphRuntimeConfigPath: '/synthetic/data/graph-runtime.json', skillsDir: '/synthetic/fuli/skills' };
const packs = loadClientDescriptorPacks();

test('FULI\'s own MCP entry for a woken client is the one its installer writes', () => {
  assert.deepEqual(fuliMcpServerEntry({ paths, runtimeConfigPath: '/synthetic/data/runtime.json', client: 'claude_code', packs }),
    { command: '/synthetic/bin/node', args: ['/synthetic/fuli/src/mcp-server.js', '--runtime-config', '/synthetic/data/runtime.json',
      '--source-application', 'claude_code', '--tool-profile', 'chat'], settings: {} });
  const codex = fuliMcpServerEntry({ paths, runtimeConfigPath: '/synthetic/data/runtime.json', client: 'codex', packs });
  assert.deepEqual(codex.args.slice(0, 5), ['/synthetic/fuli/src/mcp-server.js', '--runtime-config', '/synthetic/data/runtime.json',
    '--source-application', 'codex']);
  assert.equal(codex.settings.default_tools_approval_mode, 'auto');
  assert.equal(fuliMcpServerEntry({ paths, runtimeConfigPath: '/x', client: 'someone_else', packs }), null);
});
