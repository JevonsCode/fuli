import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGraphBackupAdapter } from '../src/backup/runtime-adapters.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

test('container backup adapter copies through an offline helper using the existing Neo4j volume',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fuli-container-backup-'));
    const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });
    await mkdir(root, { recursive: true });
    await writeFile(paths.graphRuntimeConfigPath, JSON.stringify({ workspaces: [] }));
    const calls = [];
    const adapter = await createGraphBackupAdapter({
      mode: 'container',
      paths,
      ensureContainer: async () => ({
        status: 'ready',
        dockerCommand: 'docker',
        dockerEnvironment: { DOCKER_HOST: 'test-socket' }
      }),
      async run(command, args, options) {
        calls.push({ command, args, options });
        if (args.includes('ps')) return 'personal-neo4j\n';
        if (args[0] === 'cp' && String(args[1]).endsWith(':/backup/neo4j.dump')) {
          await writeFile(args[2], 'container graph');
        }
        return '';
      }
    });
    const output = join(root, 'personal.dump');
    const input = join(root, 'portable.dump');
    await writeFile(input, 'portable graph');

    const lifecycle = await adapter.stop();
    assert.equal(await adapter.hasData('personal'), true);
    await adapter.dump('personal', output);
    await adapter.load('personal', input);
    await adapter.start(lifecycle);

    assert.deepEqual(lifecycle, {
      resume: true,
      resumeServices: ['personal-neo4j']
    });
    const dump = calls.find(({ args }) => args.includes('dump'));
    assert.equal(dump.command, 'docker');
    assert.equal(dump.options.env.DOCKER_HOST, 'test-socket');
    assert.deepEqual(dump.args.slice(-7), [
      'exec', dump.args[1], 'neo4j-admin', 'database', 'dump', 'neo4j', '--to-path=/backup'
    ]);
    assert.equal(calls.some(({ args }) => args[0] === 'cp' && args[2] === output), true);
    assert.equal(calls.some(({ args }) =>
      args[0] === 'cp' && args[1] === input &&
      String(args[2]).endsWith(':/backup/neo4j.dump')), true);
    assert.equal(calls.some(({ args }) => args.includes('load') &&
      args.includes('--overwrite-destination=true')), true);
    assert.equal(calls.every(({ args }) => !args.includes('-v')), true);
    assert.equal(calls.some(({ args }) => args[0] === 'rm' && args[1] === '--force'), true);
    const start = calls.find(({ args }) => args.includes('up') && args.includes('--no-build'));
    assert.equal(start.args.includes('personal-neo4j'), true);
    assert.equal(start.args.includes('personal-provider'), false);
  });
