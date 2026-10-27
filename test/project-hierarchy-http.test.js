import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { handleProjectHierarchyRequest } from '../src/http/project-hierarchy-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { projectHierarchyConsole } from '../src/project-hierarchy/console-port.js';
import { reachableModules } from '../test-support/module-graph.js';

// 调整层级: the person's move of a project in the console's projects view.
// Synthetic Provider: it records what the console sent and answers like it.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const app = { config: { personal: { spaceId: 'personal-space' } } };

function hierarchy(reply = () => ({ status: 200, body: { changed: true } })) {
  const calls = [];
  const port = projectHierarchyConsole('synthetic-data-dir', { send: async (path, body, options) => {
    calls.push({ path, body, ...options });
    const { status, body: payload } = reply();
    return { ok: status < 400, status, payload };
  } });
  return { port, calls };
}

async function post(port, path, body, remoteAddress = '127.0.0.1') {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { 'content-type': 'application/json' }, socket: { remoteAddress } });
  try {
    const handled = await handleProjectHierarchyRequest({ request, response,
      url: new URL(`http://127.0.0.1${path}`), app, hierarchyConsole: port });
    return { handled, ...sent };
  } catch (error) {
    return { handled: true, ...mapHttpError(error) };
  }
}

test('a move goes to the Provider on the human-review channel with the new parent', async () => {
  const { port, calls } = hierarchy();
  const moved = await post(port, '/api/personal-projects/app%2Fweb/parent',
    { personalSpaceId: 'personal-space', parentProjectId: 'platform' });
  assert.equal(moved.status, 200);
  const top = await post(port, '/api/personal-projects/app/parent',
    { personalSpaceId: 'personal-space', parentProjectId: null });
  assert.equal(top.status, 200);
  assert.deepEqual(calls.map(({ path, body, review }) => ({ path, parent: body.parent_project_id, review })), [
    { path: '/v1/personal-spaces/personal-space/projects/app%2Fweb/parent', parent: 'platform', review: true },
    { path: '/v1/personal-spaces/personal-space/projects/app/parent', parent: null, review: true },
  ]);
  assert.ok(calls.every(({ body }) => body.reason.length > 0), 'every move carries a reason for its review event');
});

test('a refused move comes back with the Provider\'s code so the page can say why', async () => {
  const { port } = hierarchy(() => ({ status: 409, body: { detail: { code: 'project_hierarchy_cycle',
    message: 'the new parent sits inside this project; moving it there would make a cycle' } } }));
  const refused = await post(port, '/api/personal-projects/platform/parent',
    { personalSpaceId: 'personal-space', parentProjectId: 'mobile' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'project_hierarchy_cycle');
});

test('bad input and another space are refused before reaching the Provider', async () => {
  const { port, calls } = hierarchy();
  for (const body of [
    { personalSpaceId: 'someone-else', parentProjectId: 'platform' },
    { personalSpaceId: 'personal-space', parentProjectId: ' ' },
    { personalSpaceId: 'personal-space' },
    { personalSpaceId: 'personal-space', parentProjectId: 'x'.repeat(129) },
  ]) {
    assert.equal((await post(port, '/api/personal-projects/app/parent', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test('a move is made only on this computer and never by an Agent tool', async () => {
  const { port, calls } = hierarchy();
  const remote = await post(port, '/api/personal-projects/app/parent',
    { personalSpaceId: 'personal-space', parentProjectId: 'platform' }, '192.168.1.20');
  assert.equal(remote.status, 403);
  assert.equal(remote.body.code, 'local_user_only');
  const unavailable = await post(null, '/api/personal-projects/app/parent',
    { personalSpaceId: 'personal-space', parentProjectId: 'platform' });
  assert.equal(unavailable.status, 503);
  assert.equal(calls.length, 0);
  const entry = agentInterfaceCatalog().uiMutationParity
    .find(({ route }) => route === 'POST /api/personal-projects/:projectId/parent');
  assert.equal(entry.access, 'local_user_only');
  assert.deepEqual(listAgentTools().filter(({ name }) => /move_.*project|project_parent/.test(name)), []);
  const writing = ['src/project-hierarchy/console-port.js', 'src/http/project-hierarchy-api-router.js']
    .map((path) => join(ROOT, path));
  for (const entryPoint of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entryPoint));
    assert.deepEqual(writing.filter((path) => modules.has(path)), [], entryPoint);
  }
});
