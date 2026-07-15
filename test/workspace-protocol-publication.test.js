import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import test from 'node:test';

import { createCanonicalBase64UrlSchema } from '../src/workspace-protocol/base64url-contract.js';
import * as protocol from '../src/workspace-protocol/index.js';

const validSource = {
  episodeId: 'episode-01J2Y7KZX8F0JQ2M6VC8DZK8B9',
  kind: 'product-requirement',
  uri: 'prd://compound-interest/requirements/publication',
  capturedAt: '2026-07-11T09:15:30.12+08:00',
  contentHash: 'a'.repeat(64),
};

const validProposal = {
  protocolVersion: '1',
  publicationId: 'publication-01J2Y7KZX8F0JQ2M6VC8DZK8B9',
  idempotencyKey: 'request  001',
  workspaceId: 'workspace-01J2Y7KZX8F0JQ2M6VC8DZK8B9',
  source: validSource,
  changes: [
    {
      clientFactId: 'client-fact-01',
      subject: 'publication contract',
      predicate: 'has_status',
      object: 'signed',
      operation: 'add',
      targetFactIds: [],
    },
  ],
  policyVersion: 'policy v1',
  signingKeyId: 'signing-key-2026',
  signature: Buffer.alloc(64).toString('base64url'),
};
const validUnsignedProposal = without(validProposal, 'signature');

const validResults = {
  effective: {
    proposalId: validProposal.publicationId,
    status: protocol.ProposalStatus.EFFECTIVE,
    workspaceRevision: '42',
    reason: null,
  },
  pendingReview: {
    proposalId: validProposal.publicationId,
    status: protocol.ProposalStatus.PENDING_REVIEW,
    workspaceRevision: null,
    reason: null,
  },
  rejected: {
    proposalId: validProposal.publicationId,
    status: protocol.ProposalStatus.REJECTED,
    workspaceRevision: null,
    reason: 'Conflicts with an effective fact',
  },
};

function captureProtocolValidationError(run, label) {
  try {
    run();
    assert.fail('Expected protocol validation to fail');
  } catch (error) {
    assert.equal(error instanceof protocol.ProtocolValidationError, true);
    assert.equal(error.message, `${label} failed protocol validation`);
    assert.ok(error.issues.length > 0);
    return error;
  }
}

function change(overrides = {}) {
  return {
    ...validProposal.changes[0],
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    ...validProposal,
    ...overrides,
  };
}

function unsignedProposal(overrides = {}) {
  return {
    ...validUnsignedProposal,
    ...overrides,
  };
}

function budgetProposal(changeCount) {
  return proposal({
    changes: Array.from({ length: changeCount }, (_, index) => change({
      clientFactId: `budget-client-fact-${index}`,
      object: `BUDGET-BODY-${index}:`.padEnd(20_000, 'x'),
    })),
  });
}

function without(value, key) {
  return Object.fromEntries(
    Object.entries(value).filter(([entryKey]) => entryKey !== key),
  );
}

test('publication contract exposes only the planned public API additions', () => {
  for (const exportName of [
    'publicationProposalSchema',
    'publicationResultSchema',
    'parsePublicationProposal',
    'parsePublicationResult',
    'publicationSigningBytes',
  ]) {
    assert.notEqual(protocol[exportName], undefined, exportName);
  }

  for (const privateExport of [
    'publicationChangeSchema',
    'unsignedPublicationProposalSchema',
    'createCanonicalBase64UrlSchema',
    'createPreservedSemanticTextSchema',
    'utf8JsonByteLength',
    'refineUtf8JsonByteBudget',
  ]) {
    assert.equal(protocol[privateExport], undefined, privateExport);
  }
});

test('publication proposal accepts and preserves a signed add proposal', () => {
  assert.deepEqual(protocol.publicationProposalSchema.parse(validProposal), validProposal);
  assert.deepEqual(protocol.parsePublicationProposal(validProposal), validProposal);
  assert.equal(
    protocol.parsePublicationProposal(validProposal).idempotencyKey,
    'request  001',
  );
  assert.equal(
    protocol.parsePublicationProposal(validProposal).policyVersion,
    'policy v1',
  );
});

test('publication signing runs through a real Ed25519 sign and verify cycle', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signingBytes = protocol.publicationSigningBytes(validUnsignedProposal);
  const signature = sign(null, signingBytes, privateKey).toString('base64url');
  const signedProposal = { ...validUnsignedProposal, signature };
  const parsed = protocol.parsePublicationProposal(signedProposal);

  assert.deepEqual(parsed, signedProposal);
  assert.equal(
    verify(
      null,
      protocol.publicationSigningBytes(without(parsed, 'signature')),
      publicKey,
      Buffer.from(parsed.signature, 'base64url'),
    ),
    true,
  );
});

test('publication change accepts every planned operation with target semantics', () => {
  const changes = [
    change(),
    change({
      clientFactId: 'client-fact-02',
      operation: 'supplement',
      targetFactIds: ['fact-existing-01'],
    }),
    change({
      clientFactId: 'client-fact-03',
      operation: 'replace',
      targetFactIds: ['fact-existing-02'],
    }),
    change({
      clientFactId: 'client-fact-04',
      operation: 'retract',
      targetFactIds: ['fact-existing-03'],
    }),
    change({
      clientFactId: 'client-fact-05',
      operation: 'restore',
      targetFactIds: ['fact-existing-04'],
    }),
  ];

  assert.deepEqual(protocol.parsePublicationProposal(proposal({ changes })).changes, changes);
});

test('publication change rejects invalid add and target-bearing operation shapes', () => {
  const invalidChanges = [
    change({ targetFactIds: ['fact-existing'] }),
    change({ operation: 'supplement', targetFactIds: [] }),
    change({ operation: 'replace', targetFactIds: [] }),
    change({ operation: 'retract', targetFactIds: [] }),
    change({ operation: 'restore', targetFactIds: [] }),
    change({ operation: 'delete', targetFactIds: ['fact-existing'] }),
  ];

  for (const invalidChange of invalidChanges) {
    captureProtocolValidationError(
      () => protocol.parsePublicationProposal(proposal({ changes: [invalidChange] })),
      'Publication proposal',
    );
  }
});

test('publication change rejects duplicate and self target fact IDs', () => {
  const duplicateTargetError = captureProtocolValidationError(
    () => protocol.parsePublicationProposal(proposal({
      changes: [change({
        operation: 'replace',
        targetFactIds: ['fact-existing', 'fact-existing'],
      })],
    })),
    'Publication proposal',
  );
  const selfTargetError = captureProtocolValidationError(
    () => protocol.parsePublicationProposal(proposal({
      changes: [change({
        operation: 'replace',
        targetFactIds: [validProposal.changes[0].clientFactId],
      })],
    })),
    'Publication proposal',
  );

  assert.equal(
    duplicateTargetError.issues.some(({ path }) => (
      path.join('.') === 'changes.0.targetFactIds.1'
    )),
    true,
  );
  assert.equal(
    selfTargetError.issues.some(({ path }) => (
      path.join('.') === 'changes.0.targetFactIds.0'
    )),
    true,
  );
});

test('publication proposal rejects duplicate client and cross-change target IDs', () => {
  const duplicateClientError = captureProtocolValidationError(
    () => protocol.parsePublicationProposal(proposal({
      changes: [change(), change()],
    })),
    'Publication proposal',
  );
  const duplicateTargetError = captureProtocolValidationError(
    () => protocol.parsePublicationProposal(proposal({
      changes: [
        change({ operation: 'replace', targetFactIds: ['fact-existing'] }),
        change({
          clientFactId: 'client-fact-02',
          operation: 'supplement',
          targetFactIds: ['fact-existing'],
        }),
      ],
    })),
    'Publication proposal',
  );

  assert.equal(
    duplicateClientError.issues.some(({ path }) => (
      path.join('.') === 'changes.1.clientFactId'
    )),
    true,
  );
  assert.equal(
    duplicateTargetError.issues.some(({ path }) => (
      path.join('.') === 'changes.1.targetFactIds.0'
    )),
    true,
  );
});

test('publication proposal rejects targets matching any client fact ID in either order', () => {
  const add = change({ clientFactId: 'new-1' });
  const replace = change({
    clientFactId: 'new-2',
    operation: 'replace',
    targetFactIds: ['new-1'],
  });

  for (const changes of [
    [add, replace],
    [replace, add],
  ]) {
    const error = captureProtocolValidationError(
      () => protocol.parsePublicationProposal(proposal({ changes })),
      'Publication proposal',
    );

    assert.equal(
      error.issues.some(({ path }) => path.at(-2) === 'targetFactIds'),
      true,
    );
  }
});

test('publication proposal requires a canonical 64-byte base64url signature', () => {
  const signature = validProposal.signature;
  const invalidSignatures = [
    `${signature.slice(0, -1)}+`,
    `${signature}=`,
    Buffer.alloc(63).toString('base64url'),
    Buffer.alloc(65).toString('base64url'),
    `${signature.slice(0, -1)}B`,
  ];

  for (const invalidSignature of invalidSignatures) {
    captureProtocolValidationError(
      () => protocol.parsePublicationProposal(proposal({
        signature: invalidSignature,
      })),
      'Publication proposal',
    );
  }
});

test('canonical base64url schemas support exact byte lengths including zero', () => {
  for (const byteLength of [0, 1, 2, 3, 4, 32, 64]) {
    const encoded = Buffer.alloc(byteLength, byteLength).toString('base64url');
    const schema = createCanonicalBase64UrlSchema(byteLength);

    assert.equal(schema.parse(encoded), encoded);
    assert.equal(schema.safeParse(`${encoded}=`).success, false);
  }
});

test('canonical base64url schema rejects invalid byte-length configuration', () => {
  for (const byteLength of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => createCanonicalBase64UrlSchema(byteLength),
      TypeError,
    );
  }
});

test('publication proposal enforces strict fields and source URI boundaries', () => {
  const invalidProposals = [
    proposal({ secret: 'must-not-cross-the-boundary' }),
    proposal({ source: { ...validSource, localPath: 'T:/private/source.md' } }),
    proposal({ source: { ...validSource, uri: 'file:///private/source.md' } }),
    proposal({
      source: {
        ...validSource,
        uri: 'prd://compound-interest/source?token=secret',
      },
    }),
    proposal({ changes: [change({ secret: 'must-not-cross-the-boundary' })] }),
  ];

  for (const invalidProposal of invalidProposals) {
    captureProtocolValidationError(
      () => protocol.parsePublicationProposal(invalidProposal),
      'Publication proposal',
    );
  }
});

test('signed and unsigned publications require a non-null source URI', () => {
  captureProtocolValidationError(
    () => protocol.parsePublicationProposal(proposal({
      source: { ...validSource, uri: null },
    })),
    'Publication proposal',
  );
  captureProtocolValidationError(
    () => protocol.publicationSigningBytes(unsignedProposal({
      source: { ...validSource, uri: null },
    })),
    'Unsigned publication proposal',
  );
});

test('publication proposal semantic text rejects empty, edge whitespace, NUL, and DEL', () => {
  const invalidValues = ['', ' ', ' value', 'value ', 'val\u0000ue', 'val\u007fue'];
  const createCases = [
    (value) => proposal({ changes: [change({ subject: value })] }),
    (value) => proposal({ changes: [change({ predicate: value })] }),
    (value) => proposal({ idempotencyKey: value }),
    (value) => proposal({ policyVersion: value }),
  ];

  for (const createCase of createCases) {
    for (const value of invalidValues) {
      captureProtocolValidationError(
        () => protocol.parsePublicationProposal(createCase(value)),
        'Publication proposal',
      );
    }
  }
});

test('publication semantic text preserves valid internal whitespace', () => {
  const signedProposal = proposal({
    idempotencyKey: 'request  001',
    policyVersion: 'policy  v1',
    changes: [change({
      subject: 'publication  contract',
      predicate: 'has  status',
    })],
  });
  const result = {
    ...validResults.rejected,
    reason: 'Conflicting  effective fact',
  };

  assert.deepEqual(protocol.parsePublicationProposal(signedProposal), signedProposal);
  assert.deepEqual(protocol.parsePublicationResult(result), result);
});

test('publication content text rejects Unicode category C and preserves empty multilingual content', () => {
  for (const object of ['unsafe\u202eobject', 'unsafe\u200bobject', ' edge', 'edge ']) {
    captureProtocolValidationError(
      () => protocol.parsePublicationProposal(proposal({ changes: [change({ object })] })),
      'Publication proposal',
    );
  }

  for (const source of [
    { ...validSource, kind: 'invalid kind' },
    { ...validSource, kind: '9invalid' },
    { ...validSource, kind: '\u4e2d\u6587' },
  ]) {
    captureProtocolValidationError(
      () => protocol.parsePublicationProposal(proposal({ source })),
      'Publication proposal',
    );
  }

  for (const object of ['', '\u5185\u5bb9  \u0645\u062d\u062a\u0648\u0649']) {
    const value = proposal({ changes: [change({ object })] });

    assert.equal(protocol.parsePublicationProposal(value).changes[0].object, object);
  }
});

test('publication signing bytes are canonical, omit only signature, and do not mutate input', () => {
  const reordered = {
    signingKeyId: validProposal.signingKeyId,
    policyVersion: validProposal.policyVersion,
    changes: validProposal.changes.map((item) => ({
      targetFactIds: item.targetFactIds,
      operation: item.operation,
      object: item.object,
      predicate: item.predicate,
      subject: item.subject,
      clientFactId: item.clientFactId,
    })),
    source: {
      contentHash: validProposal.source.contentHash,
      capturedAt: validProposal.source.capturedAt,
      uri: validProposal.source.uri,
      kind: validProposal.source.kind,
      episodeId: validProposal.source.episodeId,
    },
    workspaceId: validProposal.workspaceId,
    idempotencyKey: validProposal.idempotencyKey,
    publicationId: validProposal.publicationId,
    protocolVersion: validProposal.protocolVersion,
  };
  const snapshot = structuredClone(reordered);
  const signingBytes = protocol.publicationSigningBytes(reordered);
  const signedValue = JSON.parse(signingBytes.toString('utf8'));
  const expected = protocol.parsePublicationProposal(validProposal);

  delete expected.signature;

  assert.equal(Buffer.isBuffer(signingBytes), true);
  assert.deepEqual(
    signingBytes,
    protocol.publicationSigningBytes(validUnsignedProposal),
  );
  assert.deepEqual(reordered, snapshot);
  assert.deepEqual(signedValue, expected);
  assert.deepEqual(Object.keys(signedValue), Object.keys(signedValue).toSorted());
  assert.deepEqual(
    Object.keys(signedValue.source),
    Object.keys(signedValue.source).toSorted(),
  );
});

test('publication signing bytes reject signed proposals and unknown fields', () => {
  for (const invalidUnsignedProposal of [
    validProposal,
    unsignedProposal({ extra: 'not-signed' }),
  ]) {
    captureProtocolValidationError(
      () => protocol.publicationSigningBytes(invalidUnsignedProposal),
      'Unsigned publication proposal',
    );
  }
});

test('unsigned proposal budget reserves the exact final signature field size', () => {
  const candidates = Array.from(
    { length: 100 },
    (_, index) => budgetProposal(index + 1),
  );
  const firstOverBudget = candidates.find((candidate) => (
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 1_048_576
  ));

  assert.notEqual(firstOverBudget, undefined);

  const exactUnsigned = structuredClone(without(firstOverBudget, 'signature'));
  const projectedBytes = Buffer.byteLength(
    JSON.stringify({ ...exactUnsigned, signature: validProposal.signature }),
    'utf8',
  );
  const excessBytes = projectedBytes - 1_048_576;
  const lastChange = exactUnsigned.changes.at(-1);

  assert.ok(excessBytes > 0);
  assert.ok(excessBytes <= lastChange.object.length);
  lastChange.object = lastChange.object.slice(0, -excessBytes);

  assert.equal(
    Buffer.byteLength(
      JSON.stringify({ ...exactUnsigned, signature: validProposal.signature }),
      'utf8',
    ),
    1_048_576,
  );
  assert.doesNotThrow(() => protocol.publicationSigningBytes(exactUnsigned));

  const overBudgetUnsigned = structuredClone(exactUnsigned);
  overBudgetUnsigned.changes.at(-1).object += 'x';

  assert.ok(
    Buffer.byteLength(JSON.stringify(overBudgetUnsigned), 'utf8')
      < 1_048_576,
  );
  captureProtocolValidationError(
    () => protocol.publicationSigningBytes(overBudgetUnsigned),
    'Unsigned publication proposal',
  );
});

test('publication proposal enforces the aggregate UTF-8 JSON byte budget', () => {
  const candidates = Array.from({ length: 100 }, (_, index) => budgetProposal(index + 1));
  const overBudgetIndex = candidates.findIndex((candidate) => (
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 1_048_576
  ));

  assert.ok(overBudgetIndex > 0);

  const withinBudgetProposal = candidates[overBudgetIndex - 1];
  const overBudgetProposal = candidates[overBudgetIndex];

  assert.equal(
    protocol.parsePublicationProposal(withinBudgetProposal).changes.length,
    withinBudgetProposal.changes.length,
  );

  const error = captureProtocolValidationError(
    () => protocol.parsePublicationProposal(overBudgetProposal),
    'Publication proposal',
  );

  assert.equal(
    error.issues.some(({ message }) => message.includes('BUDGET-BODY')),
    false,
  );
});

test('publication result accepts valid status, revision, and reason combinations', () => {
  for (const result of Object.values(validResults)) {
    assert.deepEqual(protocol.publicationResultSchema.parse(result), result);
    assert.deepEqual(protocol.parsePublicationResult(result), result);
  }
});

test('publication result enforces status, revision, and reason consistency', () => {
  const invalidResults = [
    { ...validResults.effective, workspaceRevision: null },
    { ...validResults.pendingReview, workspaceRevision: '42' },
    { ...validResults.rejected, workspaceRevision: '42' },
    { ...validResults.rejected, reason: null },
    { ...validResults.rejected, reason: '' },
    { ...validResults.rejected, reason: ' ' },
    { ...validResults.rejected, reason: ' reason' },
    { ...validResults.rejected, reason: 'reason ' },
    { ...validResults.rejected, reason: 'rea\u0000son' },
    { ...validResults.rejected, reason: 'rea\u007fson' },
    { ...validResults.effective, workspaceRevision: '01' },
    { ...validResults.effective, secret: 'must-not-cross-the-boundary' },
  ];

  for (const result of invalidResults) {
    captureProtocolValidationError(
      () => protocol.parsePublicationResult(result),
      'Publication result',
    );
  }
});

test('publication parsers expose stable protocol errors instead of Zod text', () => {
  const proposalError = captureProtocolValidationError(
    () => protocol.parsePublicationProposal({}),
    'Publication proposal',
  );
  const resultError = captureProtocolValidationError(
    () => protocol.parsePublicationResult({}),
    'Publication result',
  );

  assert.equal(proposalError.name, 'ProtocolValidationError');
  assert.equal(resultError.name, 'ProtocolValidationError');
  assert.equal(proposalError.message.includes('Zod'), false);
  assert.equal(resultError.message.includes('Zod'), false);
});
