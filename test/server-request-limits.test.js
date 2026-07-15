import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import {
  localServerAuthority,
  rejectDisallowedRequest
} from '../src/http/request-policy.js';
import { createServer } from '../src/server.js';
import { closeServer } from '../test-support/server.js';

const JSON_BODY_LIMIT = 64 * 1024;

test('every POST route under /api/ requires application/json', async (t) => {
  let bootstrapCalls = 0;
  const app = {
    bootstrap() {
      bootstrapCalls += 1;
      return {};
    }
  };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const responses = await Promise.all(
    ['/api/bootstrap', '/api/future-route'].map((path) => fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    }))
  );

  assert.deepEqual(responses.map(({ status }) => status), [415, 415]);
  assert.equal(bootstrapCalls, 0);
});

test('malformed JSON remains a controlled bad request', async (t) => {
  let createSpaceCalls = 0;
  const app = {
    createSpace() {
      createSpaceCalls += 1;
    }
  };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));

  const response = await fetch(`${url}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Malformed JSON' });
  assert.equal(createSpaceCalls, 0);
});

test('JSON bodies are bounded at 64 KiB for chunked requests', async (t) => {
  let createSpaceCalls = 0;
  const app = {
    createSpace() {
      createSpaceCalls += 1;
      return { id: `space-${createSpaceCalls}` };
    }
  };
  const { server, url } = await createServer({ app, port: 0 });
  t.after(() => closeServer(server));
  const acceptedBody = jsonBodyOfSize(JSON_BODY_LIMIT);
  const rejectedBody = jsonBodyOfSize(JSON_BODY_LIMIT + 1, 'private-body-marker');

  const accepted = await chunkedJsonRequest(`${url}/api/spaces`, [acceptedBody]);
  const rejected = await chunkedJsonRequest(`${url}/api/spaces`, [
    rejectedBody.slice(0, JSON_BODY_LIMIT),
    rejectedBody.slice(JSON_BODY_LIMIT)
  ]);

  assert.equal(accepted.status, 200);
  assert.deepEqual(rejected, {
    status: 413,
    body: { error: 'Request body too large' }
  });
  assert.equal(createSpaceCalls, 1);
  assert.doesNotMatch(JSON.stringify(rejected.body), /private-body-marker/);
});

test('HTTP port 80 uses browser-normalized URL and request authority', () => {
  const authority = localServerAuthority({
    address: '127.0.0.1',
    family: 'IPv4',
    port: 80
  });
  const response = unexpectedResponse();

  assert.equal(authority, '127.0.0.1');
  assert.equal(`http://${authority}`, 'http://127.0.0.1');
  assert.equal(rejectDisallowedRequest({
    request: {
      method: 'GET',
      url: '/api/state',
      headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' }
    },
    response,
    authority
  }), false);
});

function jsonBodyOfSize(size, marker = '') {
  const empty = JSON.stringify({ name: '', kind: 'public' });
  const fillSize = size - Buffer.byteLength(empty) - Buffer.byteLength(marker);
  const body = JSON.stringify({ name: `${marker}${'x'.repeat(fillSize)}`, kind: 'public' });
  assert.equal(Buffer.byteLength(body), size);
  return body;
}

function chunkedJsonRequest(url, chunks) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, (response) => {
      const responseChunks = [];
      response.on('data', (chunk) => responseChunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(responseChunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function unexpectedResponse() {
  return {
    writeHead() {
      assert.fail('normalized local request was rejected');
    },
    end() {
      assert.fail('normalized local request was rejected');
    }
  };
}
