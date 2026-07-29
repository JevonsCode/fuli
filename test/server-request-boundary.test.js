import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { closeServer } from '../test-support/server.js';

test('foreign Host cannot read API state', async (t) => {
  let stateCalls = 0;
  const app = {
    state() {
      stateCalls += 1;
      return { private: true };
    }
  };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const status = await rawStatus(`${url}/api/state`, {
    headers: { host: 'attacker.example' }
  });

  assert.deepEqual(
    { status, stateCalls },
    { status: 403, stateCalls: 0 }
  );
});

for (const attack of [
  {
    name: 'foreign Origin',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }
  },
  {
    name: 'cross-site Fetch Metadata',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }
  },
  {
    name: 'text/plain JSON',
    headers: { 'content-type': 'text/plain' },
    status: 415
  }
]) {
  test(`${attack.name} cannot mutate the API`, async (t) => {
    let createSpaceCalls = 0;
    const app = {
      createSpace() {
        createSpaceCalls += 1;
        return { id: 'space-1' };
      }
    };
    const { server, url } = await createServer({ app, port: 0 });
    t.after(() => closeServer(server));

    const response = await fetch(`${url}/api/spaces`, {
      method: 'POST',
      headers: attack.headers,
      body: JSON.stringify({ name: 'Owned', kind: 'public' })
    });

    assert.deepEqual(
      { status: response.status, createSpaceCalls },
      { status: attack.status ?? 403, createSpaceCalls: 0 }
    );
  });
}

test('exact local browser authority and requests without Origin keep working', async (t) => {
  let createSpaceCalls = 0;
  const app = {
    createSpace(name, kind) {
      createSpaceCalls += 1;
      return { id: 'space-1', name, kind };
    }
  };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const created = await fetch(`${url}/api/spaces`, {
    method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Local', kind: 'public' })
  });
  const favicon = await fetch(`${url}/favicon.ico`);
  const index = await fetch(url);
  const indexHtml = await index.text();
  const entryPath = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  const entry = entryPath ? await fetch(new URL(entryPath, url)) : null;

  assert.equal(new URL(url).port, String(server.address().port));
  assert.equal(created.status, 200);
  assert.equal(createSpaceCalls, 1);
  assert.equal(favicon.status, 204);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.ok(entryPath);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-type'), /^text\/javascript/);
  assert.ok((await entry.text()).length > 100_000);
});

function rawStatus(url, options) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}
