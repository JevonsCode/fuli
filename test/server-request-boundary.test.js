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
  assert.equal(favicon.headers.get('content-type'), 'image/x-icon');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.ok(entryPath);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-type'), /^text\/javascript/);
  assert.match(entrySource, /#app/);
});

test('workspace deep links revalidate HTML and missing build chunks are not cached', async (t) => {
  const { server, url } = await createServer({ app: {}, port: 0 });
  t.after(() => closeServer(server));
  const page = await fetch(`${url}/employees/jefa`);
  const missing = await fetch(`${url}/assets/EmployeeWorkbenchPage-previous-build.js`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await missing.text(), /<html/i);
});

test('Agent profile deep links accept dotted identities without serving missing assets as HTML', async (t) => {
  const { server, url } = await createServer({ app: {}, port: 0 });
  t.after(() => closeServer(server));
  for (const path of ['/agents/space-a/employee.jefa', '/agents/space-a/employee%2Ejefa']) {
    const page = await fetch(`${url}${path}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
  }
  for (const path of ['/assets/missing.js', '/agents/space-a/employee.jefa/missing.js']) {
    const missing = await fetch(`${url}${path}`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /<html/i);
  }
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

  const authorization = `Basic ${Buffer.from(`fuli:${accessCode}`).toString('base64')}`;
  assert.equal(await rawStatus(`${url}/api/state`, {
    headers: {
      host: lanAuthority,
      authorization: `\u00e9${authorization.slice(1)}`
    }
  }), 401);
  assert.equal(stateCalls, 0);

  assert.equal(await rawStatus(`${url}/api/state`, {
    headers: {
      host: lanAuthority,
      authorization
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

// Raw requests: fetch() sets its own Sec-Fetch-Mode, a browser navigation does not.
function rawResponse(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'] ?? '' }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

test('a console page opened from another site\'s link is served, and only as the static console (rec#40 A1)', async (t) => {
  let stateCalls = 0;
  const app = { state() { stateCalls += 1; return { private: true }; } };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const page = await rawResponse(`${url}/employees/jefa`, { headers: navigation });
  assert.equal(page.status, 200);
  assert.match(page.type, /^text\/html/);
  // Navigating to an API path from another site never reaches its handler.
  const api = await rawResponse(`${url}/api/state`, { headers: navigation });
  assert.doesNotMatch(api.type, /json/);
  assert.equal(stateCalls, 0);
});

for (const [name, headers, method] of [
  ['a frame', { ...navigation, 'sec-fetch-dest': 'iframe' }, 'GET'],
  ['a fetch', { ...navigation, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, 'GET'],
  ['a script', { ...navigation, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }, 'GET'],
  ['a form post', { ...navigation, 'content-type': 'application/json' }, 'POST']
]) {
  test(`${name} from another site is still refused`, async (t) => {
    let calls = 0;
    const app = { state() { calls += 1; return {}; }, captureSessionKnowledge() { calls += 1; return {}; } };
    const { server, url } = await createServer({ app, port: 0 });
    t.after(() => closeServer(server));
    const response = await rawResponse(`${url}${method === 'POST' ? '/api/capture' : '/api/state'}`,
      { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.deepEqual({ status: response.status, calls }, { status: 403, calls: 0 });
  });
}

test('a repeated Sec-Fetch-Site header never hides a cross-site request', async (t) => {
  let stateCalls = 0;
  const app = { state() { stateCalls += 1; return {}; } };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));
  // Two header lines, which Node joins as "cross-site, cross-site".
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/state`, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.setHeader('sec-fetch-site', ['cross-site', 'cross-site']);
    request.on('error', reject);
    request.end();
  });
  assert.deepEqual({ status, stateCalls }, { status: 403, stateCalls: 0 });
});
