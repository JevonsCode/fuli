import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runSetupCommand } from '../src/cli/setup-command.js';
import { discoverAgents } from '../src/setup/agents.js';

test('setup tells the user to review newly installed Codex hooks', async (t) => {
  const { run, output } = isolatedSetup(t);
  const result = await run();

  assert.equal(result.status, 'ready');
  assert.equal(result.agents[0].trustReviewRequired, true);
  assert.match(output.join('\n'), /review and trust.*\/hooks/i);
  assert.match(output.join('\n'), /before relying on automatic task entry/i);
});

test('repeating setup does not imply unchanged Codex hooks are trusted', async (t) => {
  const { run, output } = isolatedSetup(t);
  await run();
  output.length = 0;
  const result = await run();

  assert.equal(result.status, 'ready');
  assert.equal(result.agents[0].newTaskRequired, false);
  assert.match(output.join('\n'), /\/hooks; setup does not verify hook trust/i);
});

function isolatedSetup(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-codex-setup-trust-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = [];
  return {
    output,
    run: () => runSetupCommand([
      '--yes', '--codex-only', '--no-start', '--data-dir', join(root, 'data')
    ], {
      env: {},
      discover: () => discoverAgents({
        homeDir: root,
        env: {},
        commandExists: (command) => command === 'codex'
      }),
      // Only the external graph-runtime startup is simulated. Planning, config
      // writes, hook installation, backups, Skills and command output are real.
      ensureRuntime: async () => ({ status: 'initialized', url: null, pid: null }),
      write: (line) => output.push(line)
    })
  };
}
