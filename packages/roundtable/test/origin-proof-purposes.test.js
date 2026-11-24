import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertionDigest, verifyOriginProof } from '../src/peer/origin-proof.js';
import { createStandaloneHost } from '../src/standalone/host.js';

// Proofs the standalone issuer signed before query and request existed, from a
// synthetic key and fixed inputs: execution and chat must keep these bytes.
const BEFORE = JSON.parse(readFileSync(new URL('./fixtures/origin-proofs-before-purposes.json', import.meta.url), 'utf8'));
const NOW = Date.parse(BEFORE.now);
const PURPOSES = ['execution', 'chat', 'query', 'request'];
const authority = { keyId: BEFORE.key.keyId, publicKey: BEFORE.key.publicKey };

function issuer() {
  const store = { spaceId: () => 'space-fixture',
    agents: () => [{ agentId: 'agent-fixture', profile: { status: 'active', name: 'Fixture' } }],
    task: () => ({ agent_id: 'agent-fixture', client: 'claude_code' }), recordOrigin: () => true,
    originKey: () => BEFORE.key };
  return createStandaloneHost({ store, now: () => NOW });
}

const assertion = { protocol: 'peer/1', messageId: BEFORE.input.messageId, threadId: 't-1', body: 'synthetic question',
  from: { node: 'f'.repeat(64), agentId: 'agent-fixture', name: 'Fixture', client: 'claude_code' },
  to: { node: BEFORE.input.targetNode, bindingId: BEFORE.input.bindingId, agentId: 'remote-lead' },
  conversation: 'auto', depth: 1, issuedAt: BEFORE.now, expiresAt: BEFORE.input.expiresAt };

async function proofFor(purpose) {
  const { proof } = await issuer().issueRemoteOrigin({ ...BEFORE.input, digest: assertionDigest(assertion), purpose });
  return { ...assertion, origin: proof };
}

const claimsOf = proof => JSON.parse(Buffer.from(proof.payload, 'base64url').toString('utf8'));

test('execution and chat proofs keep the exact bytes they had before', async () => {
  const host = issuer();
  assert.deepEqual((await host.issueRemoteOrigin(BEFORE.input)).proof, BEFORE.proofs.default);
  for (const purpose of ['execution', 'chat']) {
    assert.deepEqual((await host.issueRemoteOrigin({ ...BEFORE.input, purpose })).proof, BEFORE.proofs[purpose], purpose);
  }
});

test('a query or request proof signs its purpose under its own version', async () => {
  for (const purpose of ['query', 'request']) {
    const claims = claimsOf((await proofFor(purpose)).origin);
    assert.equal(claims.purpose, purpose);
    assert.equal(claims.version, `fuli-${purpose}-origin/1`);
  }
});

test('a proof satisfies only the purpose it was issued for', async () => {
  for (const issued of PURPOSES) {
    const signed = await proofFor(issued);
    for (const checked of PURPOSES) {
      if (issued === checked) {
        assert.equal(verifyOriginProof(signed, authority, { now: NOW, purpose: checked }).agentId, 'agent-fixture');
      } else {
        assert.throws(() => verifyOriginProof(signed, authority, { now: NOW, purpose: checked }),
          { code: 'origin_rejected' }, `${issued} proof passed a ${checked} check`);
      }
    }
  }
});

// What an issuer that signed a purpose under the execution version would send.
function forged(claimsChange) {
  const claims = { ...claimsOf(BEFORE.proofs.execution), digest: assertionDigest(assertion), ...claimsChange };
  const payload = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(claims).sort(([a], [b]) => (a < b ? -1 : 1)))));
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: BEFORE.key.privateKey, x: BEFORE.key.publicKey },
    format: 'jwk' });
  return { ...assertion, origin: { payload: payload.toString('base64url'), signature: sign(null, payload, key).toString('base64url') } };
}

test('an execution check refuses an execution-version proof that names another purpose', () => {
  assert.equal(verifyOriginProof(forged({}), authority, { now: NOW }).agentId, 'agent-fixture');
  assert.equal(verifyOriginProof(forged({ purpose: 'execution' }), authority, { now: NOW }).agentId, 'agent-fixture');
  for (const purpose of ['chat', 'query', 'request']) {
    assert.throws(() => verifyOriginProof(forged({ purpose }), authority, { now: NOW }), { code: 'origin_rejected' }, purpose);
    // Nor does the right purpose under the execution version pass its own check.
    assert.throws(() => verifyOriginProof(forged({ purpose }), authority, { now: NOW, purpose }), { code: 'origin_rejected' });
  }
  // A query version without the signed purpose is not a query proof.
  assert.throws(() => verifyOriginProof(forged({ version: 'fuli-query-origin/1' }), authority, { now: NOW, purpose: 'query' }),
    { code: 'origin_rejected' });
});

test('an unknown purpose is neither issued nor checked', async () => {
  await assert.rejects(issuer().issueRemoteOrigin({ ...BEFORE.input, purpose: 'trusted' }), { code: 'validation' });
  const signed = await proofFor('query');
  assert.throws(() => verifyOriginProof(signed, authority, { now: NOW, purpose: 'trusted' }), { code: 'origin_rejected' });
  assert.throws(() => verifyOriginProof(signed, authority, { now: NOW, purpose: 'toString' }), { code: 'origin_rejected' });
});
