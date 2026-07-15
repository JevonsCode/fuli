import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import * as protocol from '../src/workspace-protocol/index.js';

const validSource = {
  episodeId: 'episode-01J2Y7KZX8F0JQ2M6VC8DZK8B9',
  kind: 'product-requirement',
  uri: 'prd://compound-interest/requirements/context-query',
  capturedAt: '2026-07-11T09:15:30.12+08:00',
  contentHash: 'a'.repeat(64),
};

const validFact = {
  id: 'fact-01J2Y7KZX8F0JQ2M6VC8DZK8B9',
  subject: 'workspace query contract',
  predicate: 'has_limit',
  object: '100 facts',
  state: protocol.FactState.ACTIVE,
  certainty: protocol.FactCertainty.CONFIRMED,
  validFrom: '2026-07-11T09:00:00Z',
  validTo: '2026-07-11T10:00:00+00:00',
  recordedAt: '2026-07-11T10:05:00.123Z',
  revision: '42',
  sources: [validSource],
  replaces: ['fact-previous'],
  replacedBy: ['fact-next'],
};

const validContextPack = {
  workspaceId: 'workspace-01J2Y7KZX8F0JQ2M6VC8DZK8B9',
  workspaceRevision: '18446744073709551615',
  generatedAt: '2026-07-11T18:10:00+08:00',
  freshness: {
    state: 'fresh',
    lastSyncedAt: '2026-07-11T10:09:59.9+08:00',
  },
  facts: [validFact],
  nextCursor: 'cursor-page-2',
  truncated: true,
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

function assertZodFailure(run) {
  assert.throws(run, (error) => error?.name === 'ZodError');
}

function createBudgetContextPack(factCount) {
  const facts = Array.from({ length: factCount }, (_, index) => {
    const objectPrefix = `BUDGET-BODY-${index}:`;

    return {
      ...validFact,
      id: `fact-budget-${index}`,
      object: objectPrefix.padEnd(20_000, 'x'),
      replaces: [],
      replacedBy: [],
    };
  });

  return {
    ...validContextPack,
    facts,
    nextCursor: null,
    truncated: false,
  };
}

test('query contract exposes the planned public API', () => {
  for (const exportName of [
    'sourceReferenceSchema',
    'factProjectionSchema',
    'workspaceQuerySchema',
    'contextPackSchema',
    'parseWorkspaceQuery',
    'parseContextPack',
  ]) {
    assert.notEqual(protocol[exportName], undefined, exportName);
  }

  for (const privateExport of [
    'idSchema',
    'revisionSchema',
    'timestampSchema',
    'sha256Schema',
    'sourceUriSchema',
    'cursorSchema',
    'rejectDuplicateValues',
  ]) {
    assert.equal(protocol[privateExport], undefined, privateExport);
  }
});

test('initial query trims selectors and applies the planned defaults', () => {
  assert.deepEqual(protocol.parseWorkspaceQuery({ text: ' compound interest ' }), {
    text: 'compound interest',
    subjects: [],
    predicates: [],
    factIds: [],
    includeHistory: false,
    limit: 20,
    cursor: null,
  });
});

test('cursor-only continuation query preserves its exact shape', () => {
  assert.deepEqual(protocol.parseWorkspaceQuery({ cursor: 'page-2' }), {
    cursor: 'page-2',
  });
});

test('initial query trims text selectors and preserves valid fact IDs', () => {
  assert.deepEqual(protocol.parseWorkspaceQuery({
    subjects: [' subject '],
    predicates: [' predicate '],
    factIds: ['fact-id'],
  }), {
    subjects: ['subject'],
    predicates: ['predicate'],
    factIds: ['fact-id'],
    includeHistory: false,
    limit: 20,
    cursor: null,
  });
});

test('workspace query rejects missing, unsafe, duplicate, and invalid selectors', () => {
  const invalidQueries = [
    {},
    { text: 'x'.repeat(513) },
    { text: 'valid', personalLens: 'private' },
    { subjects: ['same', 'same'] },
    { predicates: ['same', 'same'] },
    { factIds: ['same', 'same'] },
    { text: 'valid', asOf: '2026-07-11T10:00:00' },
    { text: '   ' },
    { subjects: ['   '] },
    { factIds: ['   '] },
    { cursor: '   ' },
    { cursor: 'page-2', text: 'selector' },
    { cursor: 'page-2', subjects: ['selector'] },
    { cursor: 'page-2', predicates: ['selector'] },
    { cursor: 'page-2', factIds: ['selector'] },
    { cursor: 'page-2', limit: 10 },
    { cursor: 'page-2', includeHistory: true },
    { cursor: 'page-2', asOf: '2026-07-11T10:00:00Z' },
  ];

  for (const query of invalidQueries) {
    captureProtocolValidationError(
      () => protocol.parseWorkspaceQuery(query),
      'Workspace query',
    );
  }
});

test('initial selectors enforce raw and normalized string bounds', () => {
  const invalidQueries = [
    { text: `${' '.repeat(256)}x${' '.repeat(256)}` },
    { subjects: [`${' '.repeat(250)}x${' '.repeat(250)}`] },
    { predicates: [`${' '.repeat(80)}x${' '.repeat(80)}`] },
  ];
  const unexpectedlyAccepted = invalidQueries.filter((query) => (
    protocol.workspaceQuerySchema.safeParse(query).success
  ));

  assert.deepEqual(unexpectedlyAccepted, []);
});

test('query IDs and cursors reject whitespace and control characters', () => {
  const invalidQueries = [
    { factIds: [' fact-id '] },
    { factIds: ['fact\u0000id'] },
    { cursor: ' page-2' },
    { cursor: 'page 2' },
    { cursor: 'page\u00002' },
    { cursor: ' '.repeat(513) },
  ];
  const unexpectedlyAccepted = invalidQueries.filter((query) => (
    protocol.workspaceQuerySchema.safeParse(query).success
  ));

  assert.deepEqual(unexpectedlyAccepted, []);
});

test('workspace query rejects duplicates after selector normalization', () => {
  const duplicateError = captureProtocolValidationError(
    () => protocol.parseWorkspaceQuery({ subjects: [' topic ', 'topic'] }),
    'Workspace query',
  );

  assert.deepEqual(duplicateError.issues[0].path, ['subjects', 1]);
});

test('workspace query rejects Unicode category C and preserves multilingual selectors', () => {
  for (const query of [
    { text: 'unsafe\u202equery' },
    { subjects: ['unsafe\u200bsubject'] },
    { predicates: ['unsafe\ue000predicate'] },
  ]) {
    captureProtocolValidationError(
      () => protocol.parseWorkspaceQuery(query),
      'Workspace query',
    );
  }

  assert.deepEqual(
    protocol.parseWorkspaceQuery({
      text: '  \u4e2d\u6587  \u0646\u0635  ',
      subjects: ['  \u4e3b\u9898  \u0627\u0644\u0645\u0648\u0636\u0648\u0639  '],
      predicates: ['  \u5173\u7cfb  \u0639\u0644\u0627\u0642\u0629  '],
    }),
    {
      text: '\u4e2d\u6587  \u0646\u0635',
      subjects: ['\u4e3b\u9898  \u0627\u0644\u0645\u0648\u0636\u0648\u0639'],
      predicates: ['\u5173\u7cfb  \u0639\u0644\u0627\u0642\u0629'],
      factIds: [],
      includeHistory: false,
      limit: 20,
      cursor: null,
    },
  );
});

test('context pack accepts source provenance, replacement links, and freshness', () => {
  assert.deepEqual(protocol.contextPackSchema.parse(validContextPack), validContextPack);
  assert.deepEqual(protocol.parseContextPack(validContextPack), validContextPack);
});

test('source references accept and canonicalize only the v1 scheme allowlist', () => {
  const canonicalUris = [
    ['HTTPS://EXAMPLE.COM/Source', 'https://example.com/Source'],
    ['http://EXAMPLE.COM/Source', 'http://example.com/Source'],
    ['prd://Workspace/Source', 'prd://Workspace/Source'],
    ['git://Repo/Source', 'git://Repo/Source'],
    ['prd://project/item', 'prd://project/item'],
    ['git://repo/commit', 'git://repo/commit'],
    ['prd://x/item', 'prd://x/item'],
    ['git://a/commit', 'git://a/commit'],
    ['github://Owner/Repo', 'github://Owner/Repo'],
    ['gitlab://Group/Repo', 'gitlab://Group/Repo'],
    ['jira://Project/ABC-1', 'jira://Project/ABC-1'],
    ['linear://Team/ISS-1', 'linear://Team/ISS-1'],
    ['notion://Workspace/Page', 'notion://Workspace/Page'],
  ];

  for (const [uri, expectedUri] of canonicalUris) {
    const parsed = protocol.sourceReferenceSchema.parse({ ...validSource, uri });

    assert.equal(parsed.uri, expectedUri);
  }

  assert.deepEqual(
    protocol.sourceReferenceSchema.parse({ ...validSource, uri: null }),
    { ...validSource, uri: null },
  );
});

test('source URI output stays bounded, canonical, and reusable', () => {
  const unicodeUri = 'https://EXAMPLE.COM/requirements/\u67e5\u8be2';
  const overBudgetUnicodeUri = `https://example.com/${'\u754c'.repeat(400)}`;
  const expectedCanonicalUri = (
    'https://example.com/requirements/%E6%9F%A5%E8%AF%A2'
  );
  const parsedOnce = protocol.sourceReferenceSchema.parse({
    ...validSource,
    uri: unicodeUri,
  });
  const parsedTwice = protocol.sourceReferenceSchema.parse(parsedOnce);

  assert.equal(parsedOnce.uri, expectedCanonicalUri);
  assert.ok(parsedOnce.uri.length <= 2_048);
  assert.deepEqual(parsedTwice, parsedOnce);
  assert.ok(overBudgetUnicodeUri.length <= 2_048);
  assert.ok(`https://example.com/${'%E7%95%8C'.repeat(400)}`.length > 2_048);
  assertZodFailure(
    () => protocol.sourceReferenceSchema.parse({
      ...validSource,
      uri: overBudgetUnicodeUri,
    }),
  );
});

test('source references reject the reviewed URI attack table', () => {
  const invalidUris = [
    'ftp://example.com/source',
    'file:///home/person/requirements.md',
    'data:text/plain,source',
    'javascript:alert(1)',
    'mailto:person@example.com',
    'C:',
    'C:relative\\requirements.md',
    'C:/Users/person/requirements.md',
    'C:\\Users\\person\\requirements.md',
    '\\\\server\\share\\requirements.md',
    '/home/person/requirements.md',
    'prd:C:/requirements.md',
    'git:C:\\requirements.md',
    'prd:\\\\server\\share',
    'prd:/requirements.md',
    'git:requirements.md',
    'prd:///requirements.md',
    'prd://compound-interest/requirement\\notes',
    'prd://compound-interest/requirement\u0000notes',
    'prd://compound-interest/requirement\u007fnotes',
    'prd://compound-interest/requirement%',
    'prd://compound-interest/requirement%G0',
    'prd://compound-interest/requirement%0G',
    'prd://compound-interest/requirement%41',
    'prd://compound-interest/\u67e5\u8be2',
    'prd://\u9879\u76ee/item',
    'prd://compound-interest/requirement?token=secret',
    'prd://compound-interest/requirement#section',
    'https://user:password@example.com/requirement',
    'https:C:/requirements.md',
    'https:example.com',
    'https:/example.com',
    'https:///example.com',
    'https:////example.com',
    'https://@example.com/source',
    `prd://compound-interest/${'x'.repeat(2_048)}`,
  ];
  const unexpectedlyAccepted = invalidUris.filter((uri) => (
    protocol.sourceReferenceSchema.safeParse({ ...validSource, uri }).success
  ));

  assert.deepEqual(unexpectedlyAccepted, []);
});

test('source references reject drive-wrapped custom URIs', () => {
  const invalidUris = [
    'prd://C:/Users/person/requirements.md',
    'git://D:/repo/commit',
    'prd://C%3A/Users/person/requirements.md',
    'git://d%3a/repo/commit',
    'prd://repo/C:/Users/person/requirements.md',
    'prd://repo/C%3A/Users/person/requirements.md',
    'git://repo/d%3a/commit',
    'prd://repo/C:%5CUsers/person/requirements.md',
    'prd://repo/C%3A%2FUsers/person/requirements.md',
    'prd://C%3A%2FUsers/person/requirements.md',
    'prd://repo/%5C%5Cserver%5Cshare',
    'prd://repo/%00',
  ];
  const unexpectedlyAccepted = invalidUris.filter((uri) => (
    protocol.sourceReferenceSchema.safeParse({ ...validSource, uri }).success
  ));

  assert.deepEqual(unexpectedlyAccepted, []);
});

test('HTTP source references reject unsafe decoded paths', () => {
  const invalidUris = [
    'https://example.com/C:%5CUsers/person/requirements.md',
    'https://example.com/C%3A%2FUsers/person/requirements.md',
    'http://example.com/%5C%5Cserver%5Cshare',
    'https://example.com/%00',
    'https://example.com/%2500',
    'https://example.com/C%253A%252FUsers',
  ];
  const unexpectedlyAccepted = invalidUris.filter((uri) => (
    protocol.sourceReferenceSchema.safeParse({ ...validSource, uri }).success
  ));

  assert.deepEqual(unexpectedlyAccepted, []);
  assert.equal(
    protocol.sourceReferenceSchema.parse({
      ...validSource,
      uri: 'https://example.com/%E8%B5%84%E6%96%99',
    }).uri,
    'https://example.com/%E8%B5%84%E6%96%99',
  );
});

test('source references reject empty query and fragment delimiters', () => {
  const invalidUris = [
    'prd://compound-interest/requirement?',
    'prd://compound-interest/requirement#',
    'prd://compound-interest/requirement?#',
  ];
  const unexpectedlyAccepted = invalidUris.filter((uri) => (
    protocol.sourceReferenceSchema.safeParse({ ...validSource, uri }).success
  ));

  assert.deepEqual(unexpectedlyAccepted, []);
});

test('duplicate source issues identify the repeated episodeId field', () => {
  const duplicateSource = {
    ...validSource,
    kind: 'meeting-notes',
    uri: 'git://compound-interest/notes/meeting.md',
  };
  const error = captureProtocolValidationError(
    () => protocol.parseContextPack({
      ...validContextPack,
      facts: [{ ...validFact, sources: [validSource, duplicateSource] }],
    }),
    'Context Pack',
  );

  assert.ok(error.issues.some(({ path }) => (
    JSON.stringify(path) === JSON.stringify([
      'facts',
      0,
      'sources',
      1,
      'episodeId',
    ])
  )));
});

test('fact projection rejects invalid source and replacement relationships', () => {
  const duplicateSource = {
    ...validSource,
    kind: 'meeting-notes',
    uri: 'git://compound-interest/notes/meeting.md',
  };
  const invalidFacts = [
    { ...validFact, sources: [validSource, duplicateSource] },
    { ...validFact, replaces: ['fact-previous', 'fact-previous'] },
    { ...validFact, replacedBy: ['fact-next', 'fact-next'] },
    { ...validFact, replaces: [validFact.id] },
    { ...validFact, replacedBy: [validFact.id] },
    { ...validFact, replaces: ['fact-shared'], replacedBy: ['fact-shared'] },
    {
      ...validFact,
      validFrom: '2026-07-11T10:00:00Z',
      validTo: '2026-07-11T09:59:59Z',
    },
  ];

  for (const fact of invalidFacts) {
    captureProtocolValidationError(
      () => protocol.parseContextPack({ ...validContextPack, facts: [fact] }),
      'Context Pack',
    );
  }
});

test('fact source capture time cannot follow the fact recording time', () => {
  const sameInstantFact = {
    ...validFact,
    recordedAt: '2026-07-11T10:05:00Z',
    sources: [{
      ...validSource,
      capturedAt: '2026-07-11T18:05:00+08:00',
    }],
  };
  const futureSourceFact = {
    ...sameInstantFact,
    sources: [{
      ...validSource,
      capturedAt: '2026-07-11T10:05:00.001Z',
    }],
  };

  assert.deepEqual(
    protocol.factProjectionSchema.parse(sameInstantFact),
    sameInstantFact,
  );
  assertZodFailure(() => protocol.factProjectionSchema.parse(futureSourceFact));
});

test('fact text and source kind enforce wire-safe preserved text contracts', () => {
  for (const fact of [
    { ...validFact, subject: 'unsafe\u0000subject' },
    { ...validFact, predicate: 'unsafe\u202epredicate' },
    { ...validFact, object: 'unsafe\u202eobject' },
    { ...validFact, object: ' object with edge whitespace' },
    { ...validFact, sources: [{ ...validSource, kind: 'invalid kind' }] },
    { ...validFact, sources: [{ ...validSource, kind: '9invalid' }] },
    { ...validFact, sources: [{ ...validSource, kind: '\u4e2d\u6587' }] },
  ]) {
    assertZodFailure(() => protocol.factProjectionSchema.parse(fact));
  }

  const multilingualFact = {
    ...validFact,
    subject: '\u4e3b\u9898 \u0627\u0644\u0645\u0648\u0636\u0648\u0639',
    predicate: '\u5173\u7cfb \u0639\u0644\u0627\u0642\u0629',
    object: '\u5185\u5bb9  \u0645\u062d\u062a\u0648\u0649',
  };

  assert.deepEqual(protocol.factProjectionSchema.parse(multilingualFact), multilingualFact);
  assert.equal(protocol.factProjectionSchema.parse({ ...validFact, object: '' }).object, '');
});

test('shared fact and workspace IDs preserve valid text and reject unsafe text', () => {
  assert.equal(protocol.factProjectionSchema.parse(validFact).id, validFact.id);

  const invalidValues = [
    { ...validFact, id: ' fact-id' },
    { ...validFact, id: 'fact-id ' },
    { ...validFact, id: 'fact\u0000id' },
    { ...validFact, id: 'fact\u200bid' },
    { ...validFact, id: 'fact\ue000id' },
    { ...validFact, id: 'fact\ud800id' },
    {
      ...validFact,
      sources: [{ ...validSource, episodeId: ' episode-id' }],
    },
  ];

  for (const fact of invalidValues) {
    assertZodFailure(() => protocol.factProjectionSchema.parse(fact));
  }

  for (const workspaceId of [' workspace-id', 'workspace-id\u0000']) {
    captureProtocolValidationError(
      () => protocol.parseContextPack({ ...validContextPack, workspaceId }),
      'Context Pack',
    );
  }
});

test('shared cursors reject format, private-use, and surrogate code points', () => {
  for (const cursor of ['cursor\u200bvalue', 'cursor\ue000value', 'cursor\ud800value']) {
    captureProtocolValidationError(
      () => protocol.parseWorkspaceQuery({ cursor }),
      'Workspace query',
    );
  }
});

test('context pack enforces cursor consistency and unique fact IDs', () => {
  const duplicateFact = {
    ...validFact,
    subject: 'a duplicate projection of the same fact',
  };
  const invalidPacks = [
    { ...validContextPack, truncated: true, nextCursor: null },
    { ...validContextPack, truncated: false, nextCursor: 'unexpected' },
    { ...validContextPack, facts: [validFact, duplicateFact] },
  ];

  for (const pack of invalidPacks) {
    captureProtocolValidationError(
      () => protocol.parseContextPack(pack),
      'Context Pack',
    );
  }
});

test('Context Pack cursors are continuation-query safe by construction', () => {
  const parsedPack = protocol.parseContextPack(validContextPack);

  assert.deepEqual(
    protocol.parseWorkspaceQuery({ cursor: parsedPack.nextCursor }),
    { cursor: validContextPack.nextCursor },
  );

  const invalidCursors = [
    ' cursor-page-2',
    'cursor page 2',
    'cursor\u0000page-2',
    'x'.repeat(513),
  ];
  const unexpectedlyAccepted = invalidCursors.filter((nextCursor) => (
    protocol.contextPackSchema.safeParse({
      ...validContextPack,
      nextCursor,
    }).success
  ));

  assert.deepEqual(unexpectedlyAccepted, []);
});

test('context pack enforces generatedAt against fact and freshness epochs', () => {
  const sameInstantPack = {
    ...validContextPack,
    facts: [{ ...validFact, recordedAt: '2026-07-11T10:10:00Z' }],
    freshness: {
      ...validContextPack.freshness,
      lastSyncedAt: '2026-07-11T05:10:00-05:00',
    },
  };
  const futureFactPack = {
    ...validContextPack,
    facts: [{ ...validFact, recordedAt: '2026-07-11T10:10:00.001Z' }],
  };
  const futureSyncPack = {
    ...validContextPack,
    freshness: {
      ...validContextPack.freshness,
      lastSyncedAt: '2026-07-11T10:10:00.001Z',
    },
  };

  assert.deepEqual(protocol.parseContextPack(sameInstantPack), sameInstantPack);
  for (const pack of [futureFactPack, futureSyncPack]) {
    captureProtocolValidationError(
      () => protocol.parseContextPack(pack),
      'Context Pack',
    );
  }
});

test('context pack fact revisions cannot exceed the workspace revision', () => {
  const boundaryRevision = '99999999999999999999';
  const validBoundaryPack = {
    ...validContextPack,
    workspaceRevision: boundaryRevision,
    facts: [
      { ...validFact, id: 'fact-lower-revision', revision: '0' },
      { ...validFact, id: 'fact-equal-revision', revision: boundaryRevision },
    ],
  };

  assert.deepEqual(protocol.parseContextPack(validBoundaryPack), validBoundaryPack);

  const error = captureProtocolValidationError(
    () => protocol.parseContextPack({
      ...validContextPack,
      workspaceRevision: '99999999999999999998',
      facts: [{ ...validFact, revision: boundaryRevision }],
    }),
    'Context Pack',
  );

  assert.ok(error.issues.some(({ path }) => (
    JSON.stringify(path) === JSON.stringify(['facts', 0, 'revision'])
  )));
});

test('context pack enforces the aggregate UTF-8 JSON byte budget', () => {
  const withinBudgetPack = createBudgetContextPack(50);
  const overBudgetPack = createBudgetContextPack(51);
  const withinBudgetBytes = Buffer.byteLength(
    JSON.stringify(withinBudgetPack),
    'utf8',
  );
  const overBudgetBytes = Buffer.byteLength(
    JSON.stringify(overBudgetPack),
    'utf8',
  );

  assert.ok(withinBudgetBytes <= 1_048_576, withinBudgetBytes);
  assert.ok(overBudgetBytes > 1_048_576, overBudgetBytes);
  assert.equal(protocol.parseContextPack(withinBudgetPack).facts.length, 50);

  const error = captureProtocolValidationError(
    () => protocol.parseContextPack(overBudgetPack),
    'Context Pack',
  );

  assert.equal(
    error.issues.some(({ message }) => message.includes('BUDGET-BODY')),
    false,
  );
});
