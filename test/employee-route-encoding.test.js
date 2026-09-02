import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { closeServer } from '../test-support/server.js';

test('malformed employee path encoding is rejected before delegation or redirect', async (t) => {
  const calls = [];
  // Transport/router are real; this employee port only records whether it was reached.
  const employees = {
    async workspace(input) { calls.push(input); return { ready: true }; },
    async handleHttp(_request, response, input) { calls.push(input); response.end('ok'); }
  };
  const { server, url } = await createServer({ app: { employees }, port: 0 });
  t.after(() => closeServer(server));
  for (const path of [
    '/api/employee-templates/%ZZ/workspace',
    '/api/employee-templates/%E0%A4%A/workspace',
    '/employee-workspaces/%ZZ/project-a/',
    '/employee-workspaces/reviewer/%E0%A4%A/',
    '/employee-workspaces/reviewer/%ZZ'
  ]) {
    const response = await fetch(`${url}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 400, path);
    assert.match((await response.json()).error, /encoding/i);
  }
  assert.equal(calls.length, 0);
  const encoded = encodeURIComponent('project:空 格');
  const valid = await fetch(`${url}/employee-workspaces/reviewer/${encoded}/`);
  assert.equal(valid.status, 200);
  assert.equal(calls[0].personalProjectId, 'project:空 格');
  const redirect = await fetch(`${url}/employee-workspaces/reviewer/${encoded}`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), `/employee-workspaces/reviewer/${encoded}/`);
});
