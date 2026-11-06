import assert from 'node:assert/strict';
import test from 'node:test';

import { handleModelBackendApiRequest } from '../src/model-backends/http.js';

const call = async ({ method = 'POST', role = 'assistant', remoteAddress = '127.0.0.1', modelBackends }) => {
  const reply = { status: null, body: null };
  const response = { setHeader() {}, writeHead(status) { reply.status = status; }, end(text) { reply.body = text ? JSON.parse(text) : null; } };
  await handleModelBackendApiRequest({ request: { method, headers: { host: '127.0.0.1' }, socket: { remoteAddress } }, response,
    url: new URL(`http://127.0.0.1/api/model-backends/roles/${role}/check`), modelBackends });
  return reply;
};
const port = (modelReceipt) => ({ checkConnection: async (role) => ({ role, modelReceipt }) });

test('a role is tested with one real request, and only the receipt comes back', async () => {
  const { status, body } = await call({ modelBackends: port({ status: 'completed', actualModel: 'synthetic-model', endpoint: 'hidden' }) });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.receipt.actualModel, 'synthetic-model');
  assert.equal(body.receipt.endpoint, undefined);
});

test('a failed test says so instead of failing the request', async () => {
  const { status, body } = await call({ modelBackends: port({ status: 'failed', failureClass: 'configuration', reason: 'authentication failed' }) });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.receipt.reason, 'authentication failed');
});

test('testing a model is a POST from this computer', async () => {
  const modelBackends = { checkConnection: async () => { throw new Error('must not run'); } };
  assert.equal((await call({ method: 'GET', modelBackends })).status, 405);
  assert.equal((await call({ remoteAddress: '192.0.2.10', modelBackends })).status, 403);
});
