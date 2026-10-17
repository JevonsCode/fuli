import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

test('native backup adapter dumps and loads through the native runtime that owns neo4j-admin',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fuli-native-backup-'));
    const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });
    await mkdir(join(root, 'native-runtime'), { recursive: true });
    await writeFile(paths.graphRuntimeConfigPath, JSON.stringify({ workspaces: [] }));
    await writeFile(paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', mode: 'native' }));
    const calls = [];
    const adapter = await createGraphBackupAdapter({
      mode: 'native',
      paths,
      createNativeServices: (options) => {
        calls.push(['services', options.personalOnly]);
        return {
          async dumpDatabase(instance, stage) {
            calls.push(['dump', instance]);
            await writeFile(join(stage, 'neo4j.dump'), 'native graph');
          },
          async loadDatabase(instance, stage) {
            calls.push(['load', instance, await readFile(join(stage, 'neo4j.dump'), 'utf8')]);
          }
        };
      }
    });
    const output = join(root, 'personal.dump');
    const input = join(root, 'container.dump');
    await writeFile(input, 'container graph');

    await adapter.dump('personal', output);
    await adapter.load('personal', input);

    assert.equal(await readFile(output, 'utf8'), 'native graph');
    assert.deepEqual(calls, [
      ['services', true],
      ['dump', 'personal'],
      ['load', 'personal', 'container graph']
    ]);
  });

test('container census counts inside a briefly started Neo4j container without passing the password',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fuli-container-census-'));
    const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });
    await writeFile(paths.graphRuntimeConfigPath, JSON.stringify({ workspaces: [] }));
    const calls = [];
    let ready = false;
    const adapter = await createGraphBackupAdapter({
      mode: 'container',
      paths,
      ensureContainer: async () => ({ status: 'ready', dockerCommand: 'docker', dockerEnvironment: {} }),
      wait: async () => { ready = true; },
      async run(_command, args) {
        calls.push(args);
        if (args.includes('ps')) return '';
        if (!args.includes('exec')) return '';
        const statement = args.at(-1);
        if (statement === 'RETURN 1 AS ready') {
          if (!ready) throw new Error('not yet');
          return 'ready\n1\n';
        }
        if (statement.includes('labels(n)')) return 'name, count\n"Entity", 5\n';
        if (statement.includes('type(r)')) return 'name, count\n"RELATES_TO", 4\n';
        if (statement.includes('"nodes"')) return 'name, count\n"nodes", 5\n';
        return 'name, count\n"relationships", 4\n';
      }
    });

    assert.deepEqual(await adapter.census('personal'), {
      nodes: 5, relationships: 4, labels: { Entity: 5 }, types: { RELATES_TO: 4 }
    });
    const compose = ['compose', '--env-file', paths.graphEnvPath, '-f', paths.graphComposePath];
    assert.deepEqual(calls[1], [...compose, 'up', '-d', '--no-build', 'personal-neo4j']);
    assert.deepEqual(calls.at(-1), [...compose, 'stop', '-t', '30', 'personal-neo4j']);
    const exec = calls.find((args) => args.includes('exec'));
    assert.deepEqual(exec.slice(compose.length, compose.length + 5), ['exec', '-T', 'personal-neo4j', 'sh', '-c']);
    assert.equal(calls.some((args) => args.some((value) => /password/i.test(value) && !value.includes('NEO4J_AUTH'))), false);
  });

test('native census starts only the database when it is stopped and stops it again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-native-census-'));
  const paths = resolveSetupPaths({ dataDir: root, packageRoot: '/package' });
  await mkdir(join(root, 'native-runtime'), { recursive: true });
  await writeFile(paths.graphRuntimeConfigPath, JSON.stringify({ workspaces: [] }));
  await writeFile(paths.nativeRuntimeManifestPath, JSON.stringify({ status: 'ready', mode: 'native' }));
  const calls = [];
  const adapter = await createGraphBackupAdapter({
    mode: 'native',
    paths,
    createNativeServices: () => ({
      start: async (options) => calls.push(['start', options]),
      stopDatabases: async () => calls.push(['stop']),
      censusDatabase: async (instance) => { calls.push(['census', instance]); return { nodes: 1 }; }
    })
  });
  assert.deepEqual(await adapter.census('personal'), { nodes: 1 });
  assert.deepEqual(calls, [['start', { providers: false }], ['census', 'personal'], ['stop']]);
});
