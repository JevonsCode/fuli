// Opt-in macOS acceptance using the public pinned Neo4j archive and an existing
// Java 21. It creates only synthetic data, isolated HOME and ephemeral ports.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveNativeJavaHome } from '../src/native-runtime/java-runtime.js';
import { installNativeNeo4j } from '../src/native-runtime/neo4j-install.js';
import { manageNativeNeo4j } from '../src/native-runtime/neo4j-lifecycle.js';
import { assertMacNativePortOwner } from '../src/native-runtime/macos-ports.js';
import { createNativeGraphServices, NATIVE_NEO4J_VERSION, NATIVE_NEO4J_SHA256, NATIVE_NEO4J_URL } from '../src/native-runtime/runtime.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

assert.equal(process.platform, 'darwin', 'This acceptance requires macOS');
assert.ok(process.env.FULI_TEST_NEO4J_ARCHIVE, 'Set FULI_TEST_NEO4J_ARCHIVE to the public pinned Unix tarball');
const archive = resolve(process.env.FULI_TEST_NEO4J_ARCHIVE);
const javaHome = await resolveNativeJavaHome(process.env);
assert.ok(javaHome, 'An existing matching Java 21 is required; this script never installs Java');
const root = await mkdtemp(join(tmpdir(), 'fuli-macos-acceptance-'));
const oldHome = process.env.HOME;
process.env.HOME = join(root, 'home');
await mkdir(process.env.HOME);
const paths = resolveSetupPaths({ dataDir: join(root, 'data') });
const password = 'synthetic-acceptance-password';
const ports = [];
for (let i = 0; i < 3; i++) ports.push(await freePort());
const settings = { ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native', ports: {
  ...DEFAULT_RUNTIME_SETTINGS.ports, personalNeo4jHttp: ports[0], personalNeo4jBolt: ports[1], personalProvider: ports[2]
} };
await mkdir(paths.nativeRuntimeDir, { recursive: true });
await writeFile(paths.runtimeSettingsPath, JSON.stringify(settings));
await writeFile(paths.graphEnvPath, `FULI_PERSONAL_NEO4J_PASSWORD=${password}\nFULI_PERSONAL_BOOTSTRAP_TOKEN=synthetic-bootstrap-acceptance\n`);
const descriptor = { status: 'ready', mode: 'native', neo4jVersion: NATIVE_NEO4J_VERSION,
  javaHome, neo4jHome: paths.nativeNeo4jHome, providerPython: process.execPath };
const services = home => createNativeGraphServices({ paths, platform: 'darwin', personalOnly: true,
  runtimeDescriptor: { ...descriptor, neo4jHome: home } });
let running;
try {
  await installNativeNeo4j({ paths, home: descriptor.neo4jHome, url: NATIVE_NEO4J_URL, sha256: NATIVE_NEO4J_SHA256 }, {
    download: (_url, destination) => copyFile(archive, destination)
  });
  console.log('PASS pinned archive integrity and atomic installation');
  await writeFile(paths.nativeRuntimeManifestPath, JSON.stringify({ version: 1, ...descriptor }));
  running = services(descriptor.neo4jHome);
  await running.start({ providers: false });
  const state = JSON.parse(await readFile(paths.nativeProcessStatePath, 'utf8'));
  await assertMacNativePortOwner(state.databases.personal, ports[1]);
  assert.deepEqual(await query('CALL dbms.components() YIELD versions RETURN versions[0]'), [[NATIVE_NEO4J_VERSION]]);
  await query("CREATE (:MacAcceptance {marker: 'synthetic-only'})");
  console.log('PASS actual Neo4j version, authenticated query, owned Bolt port, synthetic write');
  const runtime = {
    consoleRunning: async () => false,
    stop: async ({ env }) => { await createNativeGraphServices({ paths, env }).stopDatabases(); return { status: 'stopped' }; },
    start: async () => { throw new Error('This acceptance never starts a console'); }
  };
  const install = (input) => installNativeNeo4j(input, { download: (_url, destination) => copyFile(archive, destination) });
  await manageNativeNeo4j({ paths, action: 'update' }, { runtime, install });
  assert.deepEqual(await query('MATCH (n:MacAcceptance) RETURN n.marker'), [['synthetic-only']]);
  await query("CREATE (:MacAcceptance {marker: 'after-switch'})");
  console.log('PASS transactional update: fresh assets, authenticated health, same offline store formats, original data kept');
  const beforeFailure = JSON.parse(await readFile(paths.nativeRuntimeManifestPath, 'utf8'));
  await assert.rejects(manageNativeNeo4j({ paths, action: 'update' }, { runtime, install,
    services: (selected, options) => {
      const actual = createNativeGraphServices({ paths, runtimeDescriptor: selected, ...options });
      if (selected.neo4jHome !== beforeFailure.neo4jHome) {
        const census = actual.checkDatabaseHealth;
        actual.checkDatabaseHealth = async instance => { await census(instance); throw new Error('injected health failure after real authenticated health'); };
      }
      return actual;
    }
  }), /previous assets were restored/);
  assert.equal(JSON.parse(await readFile(paths.nativeRuntimeManifestPath, 'utf8')).neo4jHome, beforeFailure.neo4jHome);
  assert.deepEqual(await query('MATCH (n:MacAcceptance) RETURN n.marker ORDER BY n.marker'), [['after-switch'], ['synthetic-only']]);
  console.log('PASS real health failure: candidate stopped, unchanged formats checked, prior descriptor/process restored, both writes kept');
  await manageNativeNeo4j({ paths, action: 'rollback' }, { runtime, install });
  assert.equal(JSON.parse(await readFile(paths.nativeRuntimeManifestPath, 'utf8')).neo4jHome, descriptor.neo4jHome);
  assert.deepEqual(await query('MATCH (n:MacAcceptance) RETURN n.marker ORDER BY n.marker'), [['after-switch'], ['synthetic-only']]);
  console.log('PASS user rollback: retained exact assets, same version/formats, both writes kept');
  await manageNativeNeo4j({ paths, action: 'uninstall' }, { runtime, install });
  running = null;
  assert.ok((await readFile(join(paths.nativePersonalDir, 'data', 'databases', 'neo4j', 'neostore'))).length);
  assert.equal(JSON.parse(await readFile(paths.nativeRuntimeManifestPath, 'utf8')).status, 'uninstalled');
  console.log('PASS uninstall: all managed Neo4j asset generations removed; synthetic external database retained');

} finally {
  if (running) await createNativeGraphServices({ paths, runtimeDescriptor: JSON.parse(await readFile(paths.nativeRuntimeManifestPath, 'utf8')) }).stopDatabases();
  process.env.HOME = oldHome;
  await rm(root, { recursive: true, force: true });
  console.log('CLEANUP synthetic database, HOME and owned processes removed');
}

async function query(statement) {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${ports[0]}/db/neo4j/tx/commit`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`neo4j:${password}`).toString('base64')}` },
        body: JSON.stringify({ statements: [{ statement }] }), signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) throw new Error('HTTP query not ready');
      const body = await response.json();
      if (body.errors?.length) throw new Error(body.errors[0].code);
      return body.results[0].data.map(item => item.row);
    } catch (error) { if (i === 59) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
