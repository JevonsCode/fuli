// A synthetic Graph Provider double and data directory for running the real
// installed lifecycle hooks end to end: the hook's own modules, local stores
// and HTTP calls, against a Provider that answers just enough for a task
// entry (one registered project, task contexts kept in memory). Synthetic
// data only; real persistence is tested against a disposable Neo4j Provider.
// Used by test/lifecycle-hook-forwarding.test.js and
// acceptance/hook-forwarding/measure.js.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const SYNTHETIC_PROJECT_ID = 'synthetic-hook-project';

export async function startSyntheticHookProvider() {
  const contexts = new Map();
  const current = new Map();
  let requests = 0;
  const answer = (method, path, query, body) => {
    if (path === '/v1/task-context-sessions/current') {
      const record = current.get(query.session_id);
      return record ? [200, record] : [404, { detail: 'not found' }];
    }
    if (path === '/v1/personal-projects') {
      return [200, [{ project_id: SYNTHETIC_PROJECT_ID, profile: { name: 'Synthetic hook project', lifecycle: 'active' } }]];
    }
    if (path === '/v1/task-contexts' && method === 'PUT') {
      const record = { ...body, checkpoint: null };
      contexts.set(body.token, record);
      current.set(body.session_id, record);
      return [200, record];
    }
    if (path.startsWith('/v1/task-contexts/')) {
      const record = contexts.get(decodeURIComponent(path.split('/')[3]));
      return record ? [200, record] : [404, { detail: 'not found' }];
    }
    if (path === '/v1/collaboration-preferences') return [200, []];
    return [200, {}];
  };
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://127.0.0.1');
    let status = 400;
    let body = { detail: 'synthetic invalid body' };
    try {
      [status, body] = answer(request.method, url.pathname, Object.fromEntries(url.searchParams), text ? JSON.parse(text) : null);
    } catch { /* answered 400 */ }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

// A data directory whose graph-runtime.json names the Provider double, with a
// folder named as the registered project and one that matches no project.
export function syntheticHookDataDirectory(parent, providerUrl) {
  const root = mkdtempSync(join(parent, 'fuli-hook-data-'));
  const dataDir = join(root, 'data');
  const projectPath = join(root, SYNTHETIC_PROJECT_ID);
  const otherPath = join(root, 'synthetic-unregistered-folder');
  for (const directory of [dataDir, projectPath, otherPath]) mkdirSync(directory, { recursive: true });
  const runtimeConfigPath = join(dataDir, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({ version: 1, personal: { providerUrl,
    accessToken: 'synthetic-hook-access-token-0123456789', principalId: 'synthetic-principal',
    spaceId: 'synthetic-space' }, workspaces: [] }));
  return { root, dataDir, runtimeConfigPath, projectPath, otherPath,
    remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

// The record the forwarder reads to find the console (setup/graph-runtime.js
// writes the real one when it starts the console).
export function recordConsole(dataDir, { url, pid = process.pid }) {
  writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid, url }));
}

export function forgetConsole(dataDir) {
  rmSync(join(dataDir, 'graph-runtime-state.json'), { force: true });
}
