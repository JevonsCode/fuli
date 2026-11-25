import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { syncGlobalCopy } from '../src/runner/global-sync.js';
import { createScopeExport } from '../src/runner/host-scope-export.js';
import { localGraphImport } from '../src/runner/local-graph-projects.js';
import { SCOPE_DIGEST_HEADER } from '../src/runner/protocol.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';
import { listenFetchableServer } from '../src/server/listen.js';

// docs/runner-roles-design.md §12 "The sync loop", end to end on a disposable Neo4j: the host's
// route exports `global` through its real Provider, the follower's real sync imports it through
// its own, a Provider restarted as a copy's leaves it as the host has it, and a copy changed
// outside the sync is written back by the next verifying sync. One Neo4j holds one copy of a
// space, so the two computers take turns on it (as graph-provider test_scope_import_neo4j.py does).
export const enabled = process.env.FULI_TEST_NEO4J_EPHEMERAL === '1' && process.env.FULI_TEST_NEO4J_URI;
export const OWNER = 'a'.repeat(64);
const BOOTSTRAP = 'synthetic-global-copy-bootstrap-1234';
const PYTHON = process.env.FULI_TEST_PYTHON ?? resolve('graph-provider/.venv/bin/python');

// dataDir: a follower's data directory already paired with its host (its store names the owner), else one
// made here under OWNER; owner: the fingerprint the copy is kept under; seedHost({ request, token, spaceId }):
// written on the host before its global is exported.
export async function replicaFixture(t, { dataDir: paired = null, owner = OWNER, seedHost = null } = {}) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.FULI_TEST_NEO4J_URI).hostname));
  const directory = mkdtempSync(join(tmpdir(), 'fuli-global-copy-neo4j-'));
  const cleanups = [() => rmSync(directory, { recursive: true, force: true, maxRetries: 5 })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

  // The host: a personal space with its defaults (the FLA roster), exported as its route answers a follower.
  let provider = await disposableProvider({ replica: false });
  const principal = await provider.request('/v1/bootstrap', { principal_name: 'Synthetic global copy acceptance' });
  const token = principal.access_token;
  const space = await provider.request('/v1/spaces', { name: 'Synthetic global copy acceptance', kind: 'personal' }, { token });
  const [{ group }] = await cypher('MATCH (s:FuliSpace {id: $space}) RETURN s.group_id AS group', { space: space.id });
  cleanups.push(() => cypher(`MATCH (space:FuliSpace {id: $space}) OPTIONAL MATCH (space)-[*1..3]->(below) WHERE NOT below:FuliSpace
    WITH space, collect(DISTINCT below) AS below OPTIONAL MATCH (owner:FuliPrincipal)-[:OWNS]->(space)
    WITH space, below, collect(owner) AS owners UNWIND below + owners + [space] AS node DETACH DELETE node`, { space: space.id })
    .then(() => cypher(`MATCH (node) WHERE node.group_id = $group OR node.personal_space_id = $space
      OR node.fuli_replica_owner = $owner DETACH DELETE node`, { space: space.id, group, owner })));
  // A Provider writes a personal space's defaults (the policy, the system FLAs) at its start.
  await provider.stop();
  provider = await disposableProvider({ replica: false });
  if (seedHost) await seedHost({ request: provider.request, token, spaceId: space.id });
  const host = createScopeExport({ app: { config: { personal: { spaceId: space.id } },
    personal: new GraphitiProviderClient({ baseUrl: provider.url, accessToken: token, requestTimeoutMs: 60_000 }) } });
  const digestAnswer = await host.answer('global', 'digest');
  const envelopeAnswer = await host.answer('global', 'envelope');
  assert.equal(digestAnswer.status, 200, JSON.stringify(digestAnswer.body));
  assert.equal(digestAnswer.body.complete, true);
  assert.ok(JSON.parse(envelopeAnswer.text).nodes.length > 0, 'the host\'s global holds its defaults');
  const formats = { graph: digestAnswer.body.graphFormat, replicaProtocol: digestAnswer.body.replicaProtocol };
  await provider.stop();

  // The follower: the space's records cleared (not the space), its Provider started as a copy's.
  await cypher(`MATCH (:FuliSpace {id: $space})-[*1..5]->(below) WHERE NOT below:FuliSpace AND NOT below:FuliPrincipal
    DETACH DELETE below`, { space: space.id });
  await cypher(`MATCH (node) WHERE NOT node:FuliSpace AND NOT node:FuliPrincipal AND (node.group_id = $group
    OR node.space_id = $space OR node.personal_space_id = $space OR node.space = $space) DETACH DELETE node`, { space: space.id, group });
  provider = await disposableProvider({ replica: true });
  const dataDir = paired ?? join(directory, 'follower');
  mkdirSync(join(dataDir, 'runner'), { recursive: true });
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  cleanups.push(() => store.close());
  if (!paired) store.saveHost({ name: 'Host A', fingerprint: owner, certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] });
  const configPath = join(dataDir, 'graph-runtime.json');
  const writeConfig = () => writeFileSync(configPath, JSON.stringify({ version: 1, personal: { providerUrl: provider.url,
    accessToken: token, principalId: principal.principal_id, spaceId: space.id }, workspaces: [] }), { mode: 0o600 });
  writeConfig();
  const asked = [];
  const connection = { current: null, getText: async (path) => {
    const part = new URL(path, 'https://x.invalid').searchParams.get('part');
    asked.push(part);
    return part === 'digest' ? { reachable: true, status: 200, text: JSON.stringify(digestAnswer.body) }
      : { reachable: true, status: 200, text: envelopeAnswer.text, headers: new Headers({ [SCOPE_DIGEST_HEADER]: envelopeAnswer.digest }) };
  } };
  const sync = (verify) => syncGlobalCopy({ dataDir, store, connection, ownFormats: formats, localSpaceId: space.id, verify,
    hostSpace: { known: true, spaceId: space.id, providerId: 'global-copy-acceptance', graphFormat: formats.graph,
      replicaProtocol: formats.replicaProtocol },
    importInto: (input) => localGraphImport(configPath, input, { timeoutMs: 120_000 }) });

  return { dataDir, spaceId: space.id, digestAnswer, asked, sync, cypher, configPath, token,
    stop: () => provider.stop(),
    async restart(replica) { await provider.stop(); provider = await disposableProvider({ replica }); writeConfig(); },
    client: () => new GraphitiProviderClient({ baseUrl: provider.url, accessToken: token }),
    async project(id) {
      return this.client().upsertPersonalProject({ personal_space_id: space.id, project_id: id,
        profile: { name: id, lifecycle: 'active', purpose: 'A synthetic local project.' } });
    }
  };

  function disposableProvider({ replica }) {
    return startReplicaTestProvider({ replica, uri: process.env.FULI_TEST_NEO4J_URI, onStop: stop => cleanups.push(stop) });
  }
}

export async function startReplicaTestProvider({ replica, uri, onStop, reviewToken, moveInstallation }) {
  assert.equal(process.env.FULI_TEST_NEO4J_EPHEMERAL, '1');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const handle = spawn(PYTHON, ['-m', 'uvicorn', 'fuli_graph.app:app', '--host', '127.0.0.1', '--port', String(port),
    '--log-level', 'error'], { cwd: resolve('graph-provider'), env: { PATH: process.env.PATH, PYTHONUNBUFFERED: '1',
    SYSTEMROOT: process.env.SYSTEMROOT, FULI_PROVIDER_ID: 'global-copy-acceptance', FULI_PROVIDER_MODE: 'personal',
    FULI_BOOTSTRAP_TOKEN: BOOTSTRAP, ...(reviewToken ? { FULI_HUMAN_REVIEW_TOKEN: reviewToken } : {}),
    FULI_GLOBAL_REPLICA: replica ? 'true' : 'false',
    ...(moveInstallation ? {
      FULI_PROJECT_GATE_DIRECTORY: join(moveInstallation.dir, 'runner', 'project-gates'),
      FULI_PROJECT_GATE_SPACE: moveInstallation.space, FULI_PROJECT_DEVICE_FINGERPRINT: moveInstallation.device,
      FULI_PROJECT_AUTHORITY_FINGERPRINT: moveInstallation.authority,
      FULI_PROJECT_MOVE_CONTROL_PATH: join(moveInstallation.dir, 'runner', 'project-moves.sqlite')
    } : {}),
    FULI_NEO4J_URI: uri, FULI_NEO4J_PASSWORD: process.env.FULI_TEST_NEO4J_PASSWORD ?? 'fixture-pass' },
  stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(handle, 'exit');
  const errors = [];
  handle.stderr.on('data', (chunk) => errors.push(chunk.toString()));
  const stop = async () => { if (handle.exitCode === null) { handle.kill('SIGTERM'); await closed; } };
  onStop(stop);
  for (let attempt = 0; ; attempt += 1) {
    if (handle.exitCode !== null) assert.fail(`Disposable Provider failed to start: ${errors.join('').slice(-3000)}`);
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
    if (attempt === 399) assert.fail(`Disposable Provider did not become healthy: ${errors.join('').slice(-3000)}`);
    await delay(100);
  }
  async function request(path, body, { token: bearer = null, method = 'POST' } = {}) {
    const response = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { 'x-fuli-bootstrap-token': BOOTSTRAP }) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.ok, true, `Fixture HTTP ${response.status}: ${path.split('?')[0]}`);
    return response.json();
  }
  return { url, request, stop };
}

// One Cypher statement on the test Neo4j through the Provider's own Python driver (Node has none).
export async function cypher(query, parameters = {}, uri = process.env.FULI_TEST_NEO4J_URI) {
  const script = 'import json, os, sys\nfrom neo4j import GraphDatabase\n'
    + 'with GraphDatabase.driver(os.environ["FULI_TEST_NEO4J_URI"], auth=("neo4j", os.environ.get("FULI_TEST_NEO4J_PASSWORD", "fixture-pass"))) as driver:\n'
    + '    records, _, _ = driver.execute_query(sys.argv[1], json.loads(sys.argv[2]))\n'
    + '    print(json.dumps([record.data() for record in records], default=str))\n';
  const handle = spawn(PYTHON, ['-c', script, query, JSON.stringify(parameters)], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, FULI_TEST_NEO4J_URI: uri,
      ...(process.env.FULI_TEST_NEO4J_PASSWORD ? { FULI_TEST_NEO4J_PASSWORD: process.env.FULI_TEST_NEO4J_PASSWORD } : {}) } });
  const out = [];
  const err = [];
  handle.stdout.on('data', (chunk) => out.push(chunk));
  handle.stderr.on('data', (chunk) => err.push(chunk));
  const [code] = await once(handle, 'exit');
  assert.equal(code, 0, Buffer.concat(err).toString().slice(-2000));
  return JSON.parse(Buffer.concat(out).toString() || '[]');
}

async function freePort() {
  const server = createServer();
  await listenFetchableServer(server, 0);
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}
