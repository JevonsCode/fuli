import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { inspectLocalRuntime } from '../src/local-runtime/lifecycle.js';

test('fl status probes the Workspace protocol and verifies its authenticated session', async (t) => {
  const requests = [];
  let authenticated = true;
  let protocolVersion = '1';
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/personal/health') {
      response.end(JSON.stringify({ status: 'ready' }));
    } else if (request.url === '/healthz') {
      response.end(JSON.stringify({ status: 'ok', protocolVersion }));
    } else if (request.url === '/v1/auth/session') {
      response.writeHead(authenticated ? 200 : 401);
      response.end(JSON.stringify(authenticated
        ? { authenticated: true }
        : { error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const inspect = () => inspectLocalRuntime({ paths: {}, port: 2727 }, {
    readConfig: () => ({
      personal: { providerUrl: `${url}/personal` },
      workspaces: [{
        providerUrl: url,
        protocol: 'fuli-workspace-v1',
        accessToken: 'synthetic-workspace-credential'
      }]
    }),
    readState: () => ({ version: 4, pid: 27, url: 'http://127.0.0.1:2727' }),
    readAdaptiveSettings: () => ({ enabled: false }),
    isProcessAlive: () => true,
    consoleHealth: async () => true
  });

  const ready = await inspect();
  assert.equal(ready.status, 'running');
  assert.equal(ready.public.status, 'ready');
  assert.deepEqual(requests.map(({ path }) => path).sort(),
    ['/healthz', '/personal/health', '/v1/auth/session']);
  assert.equal(requests.find(({ path }) => path === '/healthz').authorization, undefined);
  assert.equal(requests.find(({ path }) => path === '/v1/auth/session').authorization,
    'Bearer synthetic-workspace-credential');
  assert.doesNotMatch(JSON.stringify(ready), /synthetic-workspace-credential/);

  authenticated = false;
  const unauthorized = await inspect();
  assert.equal(unauthorized.public.status, 'unavailable');
  assert.equal(unauthorized.personal.status, 'ready');
  assert.doesNotMatch(JSON.stringify(unauthorized), /synthetic-workspace-credential/);

  authenticated = true;
  protocolVersion = '2';
  const incompatible = await inspect();
  assert.equal(incompatible.public.status, 'unavailable');
  assert.equal(incompatible.personal.status, 'ready');
});
