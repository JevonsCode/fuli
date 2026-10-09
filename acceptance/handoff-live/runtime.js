import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const composeFile = resolve(root, 'acceptance/alignment/compose.yml');
const secret = () => randomBytes(24).toString('hex');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function cleanupRuntime(compose, directory, project, primaryError) {
  const failures = [];
  try {
    const stopped = await compose('down', '--volumes', '--remove-orphans');
    if (stopped.code !== 0 || stopped.error) throw new Error('Docker cleanup failed');
  } catch { failures.push(`Cleanup failed; inspect Docker Compose project ${project}`); }
  try {
    // Verify the exact mkdtemp target before recursive deletion, even if Docker failed.
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('fuli-handoff-')) {
      throw new Error('Refusing cleanup outside the generated fixture directory');
    }
    await rm(directory, { recursive: true, force: true });
  } catch { failures.push('Private fixture directory cleanup failed'); }
  if (failures.length) {
    if (primaryError) primaryError.message += `; ${failures.join('; ')}`;
    else throw new Error(failures.join('; '));
  } else console.log('Disposable containers, volume and credentials removed.');
}

export async function withIsolatedRuntime(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-handoff-'));
  const project = `fuli-handoff-${randomBytes(5).toString('hex')}`;
  const providerPort = await freePort();
  const env = { ...process.env,
    FULI_ALIGNMENT_NEO4J_PASSWORD: secret(), FULI_ALIGNMENT_BOOTSTRAP_TOKEN: secret(),
    FULI_ALIGNMENT_HUMAN_REVIEW_TOKEN: secret(), FULI_ALIGNMENT_WORKFLOW_OBSERVATION_TOKEN: secret(),
    FULI_ALIGNMENT_NEO4J_HTTP_PORT: String(await freePort()),
    FULI_ALIGNMENT_NEO4J_BOLT_PORT: String(await freePort()),
    FULI_ALIGNMENT_PROVIDER_PORT: String(providerPort)
  };
  const compose = (...args) => run('docker', ['compose', '-p', project, '-f', composeFile, ...args], { env, timeoutMs: 600_000 });
  const providerUrl = `http://127.0.0.1:${providerPort}`;
  let accessToken;
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${providerUrl}${path}`, { method,
      headers: { 'content-type': 'application/json', ...(accessToken
        ? { authorization: `Bearer ${accessToken}` }
        : { 'x-fuli-bootstrap-token': env.FULI_ALIGNMENT_BOOTSTRAP_TOKEN }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`Fixture API ${method} ${path.split('?')[0]}: ${response.status}`);
    return value;
  }
  let primaryError;
  try {
    console.log('Starting disposable Neo4j and Provider (no production data).');
    const started = await compose('up', '-d', '--build');
    if (started.code !== 0) throw new Error('Disposable Docker stack failed to start');
    let healthy = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { healthy = (await fetch(`${providerUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!healthy) throw new Error('Disposable Provider did not become healthy');
    const bootstrap = await api('/v1/bootstrap', { principal_name: 'Synthetic cross-client acceptance' });
    accessToken = bootstrap.access_token;
    const space = await api('/v1/spaces', { name: 'Synthetic handoff acceptance', kind: 'personal' });
    const runtimeConfigPath = join(directory, 'runtime.private.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ version: 1, personal: {
      providerUrl, accessToken, principalId: bootstrap.principal_id, spaceId: space.id,
      workflowObservationToken: env.FULI_ALIGNMENT_WORKFLOW_OBSERVATION_TOKEN
    }, workspaces: [] }), { mode: 0o600 });
    await callback({ directory, runtimeConfigPath, api, spaceId: space.id,
      mcpServerPath: resolve(root, 'src/mcp-server.js') });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupRuntime(compose, directory, project, primaryError);
  }
}
