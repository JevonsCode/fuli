import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { callRoundtableTool } from '../src/agent-roundtable/tools.js';
import { createVisitRequests } from '../src/visit-requests/service.js';
import { device, pair, remoteAddress } from './fixtures/peer-devices.js';

// Two synthetic paired devices in this process; the owner's runner is a fake
// that never starts a client or touches Git.
const DRAFT = { title: 'Read the port from settings', what: 'The server should read its port from settings.json.',
  expectedAreas: ['src/server.js'] };

// overrides: runner steps replaced for one test.
function ownerRequests(calls, overrides = {}) {
  const runner = {
    folder: async () => '/synthetic/beta',
    planned: (request) => ({ worktreePath: `/synthetic/wt/${request.id}`, branch: `fuli/visit/${request.id}` }),
    prepare: async (request) => {
      calls.prepared.push({ id: request.id, projectFolder: request.projectFolder, projectId: request.projectId, agentId: request.agentId });
      return { projectFolder: '/synthetic/beta', worktreePath: `/synthetic/wt/${request.id}`, branch: `fuli/visit/${request.id}`,
        baseCommit: '1'.repeat(40) };
    },
    plan: async () => ({ plan: { areas: ['src/server.js'], risks: [], dependencyChanges: false, configChanges: false, network: false,
      size: 's' }, error: null, ms: 5 }),
    run: async () => ({ ms: 7, hold: null, summary: 'Reads the port from settings now.', intact: true, addedText: '+port',
      files: [{ path: 'src/server.js', added: 2, removed: 1 }], diffstat: { files: 1, added: 2, removed: 1 } }),
    patch: async () => ({ text: 'diff --git a/src/server.js b/src/server.js\n+SECRET-PATCH-LINE', truncated: false }),
    remove: async () => {},
    ...overrides
  };
  return ({ store, modeOf }) => createVisitRequests({ store, modeOf, runner, leads: { confirm: async () => true, constrainedClients: async () => ['claude_code'], describe: async () => null } });
}

const visit = (app, input) => callRoundtableTool(app.roundtable, 'visit_shared_lead',
  { taskContextToken: 'alpha-task', sourceApplication: 'codex', ...input });

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail('did not happen');
}

test('a paired device\'s lead requests work; the owner decides; the requester reads only its own request\'s result, never the patch',
  { timeout: 60_000 }, async () => {
    const calls = { prepared: [] };
    const [alpha, beta] = await Promise.all([device('alpha'),
      device('beta', { search: async () => ({ facts: [], entities: [] }), requests: ownerRequests(calls) })]);
    try {
      await pair(alpha, beta);
      const address = await remoteAddress(alpha.app);

      const submitted = await visit(alpha.app, { address, action: 'request', request: DRAFT });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      assert.deepEqual(Object.keys(submitted.remote), ['requestId', 'state']);
      assert.equal(submitted.remote.state, 'planning');
      assert.match(submitted.guidance, /owner of that computer decides/);
      // A request is signed for its own purpose, which the sending Provider gives only to a project lead's task.
      assert.equal(alpha.calls.origins.at(-1).purpose, 'request');
      const { requestId } = submitted.remote;

      // The owner's side planned it on its own share: its project and lead, never the asker's words.
      const owner = beta.app.visitorAccess.requests;
      await until(async () => (await owner.card(requestId)).request?.state === 'awaiting_owner');
      const alphaDevice = await loadDeviceIdentity(alpha.app.peer.directory);
      const { request } = await owner.card(requestId);
      assert.deepEqual([request.requesterKey, request.projectId, request.agentId, request.title, request.modeAtReceipt],
        [`peer:${alphaDevice.fingerprint}`, 'beta-project', 'beta-lead', DRAFT.title, 'plan']);
      assert.deepEqual(beta.calls.wakes, [], 'a request wakes nothing through the remote ask path');

      const waiting = await visit(alpha.app, { address, action: 'request_status', requestId });
      assert.deepEqual(waiting.remote, { requestId, state: 'awaiting_owner', title: DRAFT.title });

      assert.equal(owner.approve(requestId).ok, true);
      await until(async () => (await owner.card(requestId)).request.state === 'awaiting_review');
      // In plan mode the requester learns of the result only once the owner kept it.
      const unseen = await visit(alpha.app, { address, action: 'request_status', requestId });
      assert.deepEqual(unseen.remote, { requestId, state: 'awaiting_owner', title: DRAFT.title });
      await owner.keep(requestId);
      const done = await visit(alpha.app, { address, action: 'request_status', requestId });
      assert.deepEqual(done.remote, { requestId, state: 'kept', title: DRAFT.title, summary: 'Reads the port from settings now.',
        branch: `fuli/visit/${requestId}`, files: ['src/server.js'], diffstat: { files: 1, added: 2, removed: 1 } });
      assert.ok(!JSON.stringify(done).includes('SECRET-PATCH-LINE'), 'the patch never crosses');

      // A request id that is not this device's own is one plain refusal.
      const other = await visit(alpha.app, { address, action: 'request_status', requestId: 'someone-elses-request' });
      assert.deepEqual([other.ok, other.code], [false, 'request_not_found']);

      // ask_only: the owner allows only questions now; a new request is refused before any plan.
      beta.app.visitorAccess.setRequesterMode({ key: `peer:${alphaDevice.fingerprint}`, kind: 'peer', label: 'Alpha', mode: 'ask_only' });
      const refused = await visit(alpha.app, { address, action: 'request', request: DRAFT });
      assert.deepEqual([refused.ok, refused.code], [false, 'ask_only']);
      assert.equal(calls.prepared.length, 1);
    } finally { await alpha.close(); await beta.close(); }
  });

test('the requester learns a folder that is no repository by its code, and never what Git said', { timeout: 60_000 }, async () => {
  const calls = { prepared: [] };
  let folders = 0;
  const gitFailure = Object.assign(new Error('git'), { code: 'git_failed', summary: 'fatal: SECRET-GIT-LINE in [path]' });
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta', { search: async () => ({ facts: [], entities: [] }),
    requests: ownerRequests(calls, {
      // The first request's folder is no repository; the second's Git step fails once it runs.
      folder: async () => { folders += 1; if (folders === 1) throw Object.assign(new Error('no'), { code: 'no_repository' }); return '/synthetic/beta'; },
      prepare: async () => { throw gitFailure; }
    }) })]);
  try {
    await pair(alpha, beta);
    const address = await remoteAddress(alpha.app);
    const owner = beta.app.visitorAccess.requests;
    const alphaDevice = await loadDeviceIdentity(alpha.app.peer.directory);
    beta.app.visitorAccess.setRequesterMode({ key: `peer:${alphaDevice.fingerprint}`, kind: 'peer', label: 'Alpha', mode: 'trusted',
      ownDevice: true });

    const first = (await visit(alpha.app, { address, action: 'request', request: DRAFT })).remote.requestId;
    await until(async () => (await owner.card(first)).request.state === 'failed');
    const noRepository = await visit(alpha.app, { address, action: 'request_status', requestId: first });
    assert.deepEqual(noRepository.remote, { requestId: first, state: 'failed', title: DRAFT.title, reason: 'no_repository' });

    const second = (await visit(alpha.app, { address, action: 'request', request: DRAFT })).remote.requestId;
    await until(async () => (await owner.card(second)).request.state === 'failed');
    assert.equal((await owner.card(second)).request.reason, 'fatal: SECRET-GIT-LINE in [path]', 'the owner reads the line Git wrote');
    const gitFailed = await visit(alpha.app, { address, action: 'request_status', requestId: second });
    assert.deepEqual(gitFailed.remote, { requestId: second, state: 'failed', title: DRAFT.title });
    assert.ok(!JSON.stringify(gitFailed).includes('SECRET-GIT-LINE'), 'what Git said never crosses');
  } finally { await alpha.close(); await beta.close(); }
});

test('a request is checked before it leaves: a draft past its bounds or a status without an id is refused here', async () => {
  const alpha = await device('alpha');
  try {
    const address = `peer:${'0'.repeat(64)}:binding-1`;
    for (const input of [{ action: 'request' }, { action: 'request', request: { title: 'x'.repeat(161), what: 'y' } },
      { action: 'request', request: { title: 'x', what: 'y', expectedAreas: Array(11).fill('a') } }, { action: 'request_status' }]) {
      await assert.rejects(visit(alpha.app, { address, ...input }), { code: 'validation' }, JSON.stringify(input).slice(0, 60));
    }
  } finally { await alpha.close(); }
});

test('revoking a paired device tells the host, which ends that device\'s open visit requests', { timeout: 60_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    const revoked = [];
    // The coordinating computer's host reads its visitor-access port when the device goes.
    alpha.app.visitorAccess = { requesterRevoked: async (key) => { revoked.push(key); }, close() {} };
    const betaDevice = await loadDeviceIdentity(beta.app.peer.directory);
    await alpha.runtime.revokeDevice(betaDevice.fingerprint);
    await until(() => revoked.length > 0);
    assert.ok(revoked.every((key) => key === `peer:${betaDevice.fingerprint}`));
  } finally { await alpha.close(); await beta.close(); }
});
