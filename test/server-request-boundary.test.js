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
    let captureCalls = 0;
    const app = {
      captureSessionKnowledge() {
        captureCalls += 1;
        return { status: 'captured' };
      }
    };
    const { server, url } = await createServer({ app, port: 0 });
    t.after(() => closeServer(server));

    const response = await fetch(`${url}/api/capture`, {
      method: 'POST',
      headers: attack.headers,
      body: JSON.stringify({ name: 'Owned', kind: 'public' })
    });

    assert.deepEqual(
      { status: response.status, captureCalls },
      { status: attack.status ?? 403, captureCalls: 0 }
    );
  });
}

test('exact local browser authority and requests without Origin keep working', async (t) => {
  let captureCalls = 0;
  const app = {
    captureSessionKnowledge(input) {
      captureCalls += 1;
      return { status: 'captured', input };
    }
  };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const captured = await fetch(`${url}/api/capture`, {
    method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Local', kind: 'public' })
  });
  const favicon = await fetch(`${url}/favicon.ico`);
  const index = await fetch(url);
  const indexHtml = await index.text();
  const entryPath = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  const entry = entryPath ? await fetch(new URL(entryPath, url)) : null;
  const entrySource = entry ? await entry.text() : '';

  assert.equal(new URL(url).port, String(server.address().port));
  assert.equal(captured.status, 200);
  assert.equal(captureCalls, 1);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get('content-type'), 'image/png');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.ok(entryPath);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-type'), /^text\/javascript/);
  assert.match(entrySource, /#app/);
});

test('loopback HTTP never proxies the independent human-review credential', async (t) => {
  let reviewCalls = 0;
  const humanReview = {
    previewWorkflowCandidateReview() {
      reviewCalls += 1;
      return { approval_token: 'must-not-be-issued' };
    }
  };
  const { server, url } = await createServer({
    app: { close() {} },
    humanReview,
    port: 0
  });
  t.after(() => closeServer(server));

  const response = await fetch(
    `${url}/api/human-review/workflow-candidates/candidate-1/review-preview`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    }
  );

  assert.equal(response.status, 404);
  assert.equal(reviewCalls, 0);
});

test('non-JSON PUT and PATCH requests cannot mutate the API', async (t) => {
  let policyCalls = 0;
  let settingsCalls = 0;
  const app = {
    updateCapturePolicy() {
      policyCalls += 1;
      return { enabled: false };
    }
  };
  const system = {
    updateSettings() {
      settingsCalls += 1;
      return {};
    }
  };
  const { server, url } = await createServer({ app, system, port: 0 });
  t.after(() => closeServer(server));

  const patch = await fetch(`${url}/api/capture-policy`, {
    method: 'PATCH',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ enabled: false })
  });
  const put = await fetch(`${url}/api/system/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ version: 1 })
  });

  assert.deepEqual(
    { patch: patch.status, put: put.status, policyCalls, settingsCalls },
    { patch: 415, put: 415, policyCalls: 0, settingsCalls: 0 }
  );
});

test('LAN mode binds a protected authority while loopback health remains available', async (t) => {
  let stateCalls = 0;
  const app = {
    state() {
      stateCalls += 1;
      return { private: true };
    }
  };
  const accessCode = 'temporary-access-code';
  const { server, url, lanUrls } = await createServer({
    app,
    port: 0,
    lan: true,
    lanAccessToken: accessCode,
    lanAddresses: ['192.168.31.8']
  });
  t.after(() => closeServer(server));
  const port = server.address().port;
  const lanAuthority = `192.168.31.8:${port}`;

  assert.deepEqual(lanUrls, [`http://${lanAuthority}`]);
  assert.equal(await rawStatus(`${url}/api/state`, {
    headers: { host: lanAuthority }
  }), 401);
  assert.equal(stateCalls, 0);

  assert.equal(await rawStatus(`${url}/api/state`, {
    headers: {
      host: lanAuthority,
      authorization: `Basic ${Buffer.from(`fuli:${accessCode}`).toString('base64')}`
    }
  }), 200);
  assert.equal(stateCalls, 1);

  assert.equal((await fetch(`${url}/api/health`)).status, 200);
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
