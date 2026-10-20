import test from 'node:test';
import assert from 'node:assert/strict';

import { readModelBackendConfig } from '../src/model-backends/config.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { createRoleWorkBridge } from '../src/model-backends/role-work.js';
import { RoleWorkStore } from '../src/model-backends/role-work-store.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';

// The session bridge is the same for every role: here a fake Bole operation
// uses it the way Tonborg does, with fake sessions and no model configured.

const SESSIONS = {
  a: { sessionRef: 'session-a', personalSpaceId: 's', personalProjectId: 'p', sourceApplication: 'codex' },
  b: { sessionRef: 'session-b', personalSpaceId: 's', personalProjectId: 'p', sourceApplication: 'claude_code' }
};
const request = (sessionRef = null) => ({
  role: 'bole', operation: 'staffing_review', requestId: 'bole-1',
  scope: { personalSpaceId: 's', personalProjectId: 'p', sessionRef },
  versions: { evidence: 'ev-1', policy: 'pol-1' }, instructions: 'Who should review next?',
  evidence: [{ id: 'e1', personalProjectId: 'p', text: 'Ada finished three reviews.' }],
  output: { type: 'choice', options: [{ id: 'ada', description: 'Ada' }, { id: 'bo', description: 'Bo' }] }
});
const answer = { decision: 'propose', payload: { choice: 'ada' }, reason: 'Recent reviews.', evidenceIds: ['e1'], uncertainty: null };

function harness(config = null) {
  const clock = { at: Date.parse('2026-10-20T12:00:00.000Z') };
  const now = () => new Date(clock.at);
  const port = createModelBackendPort({ readConfig: () => config ? readModelBackendConfig('x', { read: () => config }) : { state: 'absent' },
    secrets: { read: async () => null }, ledger: new ModelUsageLedger(), now,
    fetchImpl: async () => { throw new Error('no model call'); } });
  const bridge = createRoleWorkBridge({ port, store: new RoleWorkStore(), now,
    verifySession: async ({ taskContextToken }) => SESSIONS[taskContextToken],
    // The role's own operation: it asks again and uses the answer it gets.
    resumers: { bole: async ({ input }) => {
      const outcome = await bridge.decide(request(input.sessionRef));
      return { choice: outcome.envelope?.payload.choice ?? null };
    } } });
  const work = (action, token, extra = {}) => bridge[action]({ taskContextToken: token, ...extra });
  const submit = (token, claimed) => work('submit', token, { packageId: claimed.packageId, leaseToken: claimed.lease.token, answer });
  return { bridge, port, clock, work, submit };
}

test('a lease expires: the late answer is stale, another session takes over, the old lease stays stale', async () => {
  const { bridge, clock, work, submit } = harness();
  const pending = await bridge.decide(request(), { resume: { sessionRef: null } });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.workPackage.reason, 'no_config');
  const { workPackage: first } = await work('claim', 'a');
  await assert.rejects(work('claim', 'b', { packageId: first.packageId }), { code: 'role_work_busy' });
  clock.at += 11 * 60_000;
  assert.equal((await submit('a', first)).reason, 'lease_expired');
  const { workPackage: second } = await work('claim', 'b');
  assert.equal(second.packageId, first.packageId);
  assert.notEqual(second.lease.token, first.lease.token);
  assert.equal((await submit('a', first)).reason, 'lease_mismatch');
  const done = await submit('b', second);
  assert.deepEqual(done, { status: 'completed', result: { choice: 'ada' } });
});

test('a package bound to a session is that session\'s only, and an unanswered package expires', async () => {
  const { bridge, clock, work } = harness();
  const bound = await bridge.decide(request('session-a'), { resume: { sessionRef: 'session-a' } });
  assert.deepEqual(await work('claim', 'b'), { workPackage: null });
  await assert.rejects(work('claim', 'b', { packageId: bound.workPackage.packageId }), { code: 'role_work_scope_mismatch' });
  clock.at += 73 * 60 * 60_000;
  assert.deepEqual(await work('claim', 'a'), { workPackage: null });
  assert.deepEqual(bridge.summary().packages, [{ role: 'bole', status: 'expired', count: 1 }]);
});

test('Settings reads each role\'s backend and the open work packages over the local HTTP API', async () => {
  const config = { version: 1, connections: { local: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: null } },
    roles: { tonborg: { enabled: true, connection: 'local', allowedOperations: ['knowledge_review'], fallbackToSession: true,
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000 } } } };
  const { bridge, port } = harness(config);
  await bridge.decide(request(), { resume: {} });
  let sent;
  const response = { setHeader() {}, writeHead: status => { sent = { status }; }, end: body => { sent.body = JSON.parse(body); } };
  assert.equal(await handleModelBackendApiRequest({ request: { method: 'GET' }, response,
    url: new URL('http://local/api/model-backends/roles'), modelBackends: port, roleWork: bridge }), true);
  assert.equal(sent.status, 200);
  const roles = Object.fromEntries(sent.body.roles.map(role => [role.role, role]));
  assert.equal(roles.bole.answeredBy, 'current_session');
  assert.equal(roles.tonborg.answeredBy, 'model_api');
  assert.equal(roles.tonborg.connection.endpointHost, '127.0.0.1:11434');
  assert.equal(roles.tonborg.connection.pricing, 'unknown');
  assert.deepEqual(sent.body.workPackages, [{ role: 'bole', status: 'pending', count: 1 }]);
  assert.doesNotMatch(JSON.stringify(sent.body), /Ada finished/);
});
