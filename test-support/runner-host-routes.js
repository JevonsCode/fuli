import { createServer } from 'node:http';

import { RunnerHostStore } from '../src/runner/host-store.js';

// A host's runner routes behind plain HTTP on loopback, the device fingerprint
// taken from a test header (the TLS listener reads it from the certificate).
export async function serveRunnerRoutes(t, routes) {
  const server = createServer((request, response) => {
    const fingerprint = request.headers['x-test-fingerprint'];
    const { pathname } = new URL(request.url, 'http://runner.invalid');
    routes.handle(request, response, { fingerprint, pathname, address: '192.0.2.30' }).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await routes.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const answer = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });
  const post = async (fingerprint, path, body) => answer(await fetch(`${origin}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-fingerprint': fingerprint }, body: JSON.stringify(body) }));
  const get = async (fingerprint, path) => answer(await fetch(`${origin}${path}`, { headers: { 'x-test-fingerprint': fingerprint } }));
  return { origin, post, get };
}

// A host store with these runners paired, each under a synthetic invitation.
export function pairedStore(...fingerprints) {
  const store = new RunnerHostStore(':memory:');
  for (const [index, fingerprint] of fingerprints.entries()) {
    const code = `synthetic-invitation-code-${index}`;
    store.invite({ code, name: `Runner ${index}` });
    store.pair({ code, fingerprint, deviceName: `device-${index}` });
  }
  return store;
}
