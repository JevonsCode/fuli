import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { runSetupCommand } from '../src/cli/setup-command.js';
import { runLocalRuntimeCommand } from '../src/cli/local-runtime-command.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { quoteShellArgument } from '../src/cli/shell-argument.js';

const tty = { isTTY: true };
const env = { TERM: 'xterm-256color' };
const fakeUrl = 'http://127.0.0.1:2727';
const fakeCode = 'sample-access-code';

async function setup(output, variables = env) {
  const lines = [];
  await runSetupCommand(['--yes'], {
    output, env: variables, write: (line) => lines.push(line),
    planSetup: () => ({ paths: { dataDir: '/tmp/Fuli example' }, agents: [] }),
    applySetup: async () => ({ status: 'ready', agents: [], runtime: { url: fakeUrl, lan: true,
      lanUrls: ['http://192.0.2.1:2727'], lanAccess: { username: 'fuli', accessCode: fakeCode } } })
  });
  return lines.join('\n');
}

test('setup highlights copyable addresses, access code and commands only in a color terminal', async () => {
  const plain = await setup({ isTTY: false });
  const color = await setup(tty);
  assert.equal(stripVTControlCharacters(color), plain);
  for (const value of [fakeUrl, fakeCode, 'fuli connect', `--data-dir ${quoteShellArgument('/tmp/Fuli example')}`]) {
    assert.ok(color.includes(`\u001b[1;36m${value}\u001b[0m`), value);
  }
  assert.equal(await setup(tty, { ...env, NO_COLOR: '1' }), plain);
  assert.equal(await setup(tty, { TERM: 'dumb' }), plain);
});

test('start also highlights the management address and temporary access code', async () => {
  const lines = [];
  await runLocalRuntimeCommand('start', [], { output: tty, env, write: (line) => lines.push(line),
    resolvePaths: () => ({}), discoverAgents: () => [],
    start: async () => ({ status: 'started', url: fakeUrl, lan: true, lanUrls: [],
      lanAccess: { username: 'fuli', accessCode: fakeCode } }) });
  assert.match(lines.join('\n'), /\u001b\[1;36mhttp:\/\/127\.0\.0\.1:2727\u001b\[0m/);
  assert.match(lines.join('\n'), /\u001b\[1;36msample-access-code\u001b\[0m/);
});

test('migration preview highlights the full apply command and leaves JSON unstyled', async () => {
  const lines = [];
  const graph = { preview: async () => ({ plan: { store: 'graph', kind: 'neo4j', action: 'apply',
    digest: 'b'.repeat(64), step: { id: 'graph/2-example', kind: 'rewrite', summary: 'Example',
      fromVersion: 1, toVersion: 2, count: 1, sampleIds: ['example'] }, undo: 'available' }, undoable: [] }) };
  const deps = { output: tty, env, write: (line) => lines.push(line), graph,
    resolvePaths: () => ({ dataDir: '/nonexistent/fuli-test-directory' }) };
  const { plan } = await runMigrateCommand(['preview'], deps);
  assert.ok(lines.join('\n').includes(`\u001b[1;36mfuli migrate apply --digest ${plan.digest} --data-dir ${quoteShellArgument('/nonexistent/fuli-test-directory')}\u001b[0m`));
  lines.length = 0;
  await runMigrateCommand(['preview', '--json'], deps);
  assert.equal(stripVTControlCharacters(lines[0]), lines[0]);
  assert.equal(JSON.parse(lines[0]).digest, plan.digest);
});
