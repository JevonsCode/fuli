import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCodexRoundtableConfig } from '../src/agents/codex/roundtable-config.js';

test('managed and project MCP entries are disabled individually and checked before execution', async () => {
  const calls = [];
  const args = await prepareCodexRoundtableConfig({ command: 'codex', workspace: '/exact/work', env: {}, platform: 'win32',
    runProcess: async (_command, options, context) => {
      calls.push(options); assert.equal(context.cwd, '/exact/work');
      return { code: 0, stdout: JSON.stringify(['managed', 'project_agent'].map(name => ({ name,
        enabled: !options.includes(`mcp_servers.${name}.enabled=false`) }))) };
    } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['mcp', 'list', '--json', ...args]);
  assert.ok(args.includes('windows.sandbox="unelevated"'));
  assert.ok(args.includes('notify=[]'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
});

test('unknown configuration, ambiguous dotted names and residual enabled servers fail closed', async () => {
  for (const result of [{ code: 1, stdout: '[]' }, { code: 0, stdout: 'not JSON' },
    { code: 0, stdout: '[{"name":"project.foo","enabled":true}]' },
    { code: 0, stdout: '[{"name":"system","enabled":true}]' }]) {
    await assert.rejects(prepareCodexRoundtableConfig({ command: 'codex', workspace: '/work', env: {},
      runProcess: async () => result }), { code: 'runtime_isolation_failed' });
  }
});
