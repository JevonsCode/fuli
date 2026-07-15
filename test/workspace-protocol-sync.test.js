import assert from 'node:assert/strict';
import test from 'node:test';

import * as protocol from '../src/workspace-protocol/index.js';
import { utf8JsonByteLength } from '../src/workspace-protocol/json-budget.js';

const recordedAt = '2026-07-12T09:30:00+08:00';

function event(eventId, workspaceRevision, type, data, at = recordedAt) {
  return {
    eventId,
    workspaceRevision,
    recordedAt: at,
    type,
    data,
  };
}

const validEvents = [
  event('event-01', '1', 'workspace.updated', { visibility: protocol.WorkspaceVisibility.PRIVATE }),
  event('event-02', '2', 'membership.changed', { subjectId: 'person-01', role: protocol.WorkspaceRole.MEMBER }),
  event('event-03', '3', 'episode.recorded', { episodeId: 'episode-01' }),
  event('event-04', '4', 'fact.activated', { factId: 'fact-01' }),
  event('event-05', '5', 'fact.superseded', { factId: 'fact-01', replacedByFactId: 'fact-02' }),
  event('event-06', '6', 'fact.retracted', { factId: 'fact-03' }),
  event('event-07', '7', 'proposal.pending', { proposalId: 'proposal-01' }),
  event('event-08', '8', 'proposal.decided', { proposalId: 'proposal-01', status: protocol.ProposalStatus.EFFECTIVE }),
  event('event-09', '9', 'signing_key.revoked', { keyId: 'signing-key-01' }),
];

const validPage = {
  workspaceId: 'workspace-01',
  events: validEvents,
  nextCursor: 'checkpoint-revision-9',
  hasMore: false,
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

function exactPath(path) {
  return JSON.stringify(path);
}

test('sync contract exposes only its planned public API additions', () => {
  for (const exportName of [
    'workspaceEventSchema',
    'syncPageSchema',
    'parseSyncPage',
  ]) {
    assert.notEqual(protocol[exportName], undefined, exportName);
  }

  for (const privateExport of [
    'workspaceUpdatedEventSchema',
    'membershipChangedEventSchema',
    'MAX_SYNC_EVENTS',
    'MAX_SYNC_PAGE_BYTES',
  ]) {
    assert.equal(protocol[privateExport], undefined, privateExport);
  }
});

test('every sync event type accepts its strict planned fixture', () => {
  for (const fixture of validEvents) {
    assert.deepEqual(protocol.workspaceEventSchema.parse(fixture), fixture);
  }

  assert.deepEqual(protocol.parseSyncPage(validPage), validPage);
});

test('membership removal and both terminal proposal statuses are valid', () => {
  const fixtures = [
    event('event-membership-removed', '10', 'membership.changed', {
      subjectId: 'person-02',
      role: null,
    }),
    event('event-proposal-rejected', '11', 'proposal.decided', {
      proposalId: 'proposal-02',
      status: protocol.ProposalStatus.REJECTED,
    }),
  ];

  for (const fixture of fixtures) {
    assert.deepEqual(protocol.workspaceEventSchema.parse(fixture), fixture);
  }
});

test('every sync event, data, and page object is strict', () => {
  captureProtocolValidationError(
    () => protocol.parseSyncPage({ ...validPage, privateBody: 'private page content' }),
    'Sync page',
  );

  for (const fixture of validEvents) {
    for (const invalidEvent of [
      { ...fixture, secret: 'private event content' },
      { ...fixture, data: { ...fixture.data, privateBody: 'private data content' } },
    ]) {
      captureProtocolValidationError(
        () => protocol.parseSyncPage({ ...validPage, events: [invalidEvent] }),
        'Sync page',
      );
    }
  }
});

test('exact duplicate events parse and preserve provider order', () => {
  const duplicate = event(
    'event-at-least-once',
    '5',
    'episode.recorded',
    { episodeId: 'episode-at-least-once' },
  );
  const events = [duplicate, structuredClone(duplicate)];
  const parsed = protocol.parseSyncPage({ ...validPage, events });

  assert.deepEqual(parsed.events, events);
  assert.deepEqual(
    parsed.events.map(({ eventId }) => eventId),
    [duplicate.eventId, duplicate.eventId],
  );
});

test('non-adjacent exact duplicates do not participate twice in revision ordering', () => {
  const duplicate = event(
    'event-non-adjacent-duplicate',
    '5',
    'episode.recorded',
    { episodeId: 'episode-non-adjacent-duplicate' },
  );
  const events = [
    duplicate,
    event('event-between-duplicate', '6', 'episode.recorded', { episodeId: 'episode-between' }),
    structuredClone(duplicate),
  ];

  assert.deepEqual(protocol.parseSyncPage({ ...validPage, events }).events, events);
});

test('conflicting reused IDs are rejected without affecting revision ordering', () => {
  const original = event('event-conflict-order', '5', 'episode.recorded', { episodeId: 'episode-original' });
  const conflict = event('event-conflict-order', '4', 'episode.recorded', { episodeId: 'episode-conflict' });
  const error = captureProtocolValidationError(
    () => protocol.parseSyncPage({
      ...validPage,
      events: [
        original,
        event('event-after-original', '6', 'episode.recorded', { episodeId: 'episode-after' }),
        conflict,
        event('event-after-conflict', '7', 'episode.recorded', { episodeId: 'episode-last' }),
      ],
    }),
    'Sync page',
  );

  assert.ok(error.issues.some(({ path }) => (
    exactPath(path) === exactPath(['events', 2, 'eventId'])
  )));
  assert.equal(error.issues.some(({ path }) => (
    path.at(-1) === 'workspaceRevision'
  )), false);
});

const reusedEventId = event(
  'event-conflicting-reuse',
  '5',
  'episode.recorded',
  { episodeId: 'episode-original' },
  '2026-07-12T01:00:00Z',
);
const conflictingEventCases = [
  {
    field: 'workspaceRevision',
    value: { ...reusedEventId, workspaceRevision: '6' },
  },
  {
    field: 'recordedAt',
    value: { ...reusedEventId, recordedAt: '2026-07-12T02:00:00Z' },
  },
  {
    field: 'type',
    value: {
      ...reusedEventId,
      type: 'fact.activated',
      data: { factId: 'fact-conflicting-reuse' },
    },
  },
  {
    field: 'data',
    value: { ...reusedEventId, data: { episodeId: 'episode-conflicting' } },
  },
];

for (const { field, value } of conflictingEventCases) {
  test(`eventId reuse rejects conflicting ${field}`, () => {
    const error = captureProtocolValidationError(
      () => protocol.parseSyncPage({
        ...validPage,
        events: [reusedEventId, value],
      }),
      'Sync page',
    );

    assert.ok(error.issues.some(({ path }) => (
      exactPath(path) === exactPath(['events', 1, 'eventId'])
    )));
  });
}

test('sync pages require nondecreasing numeric revisions', () => {
  const sameRevision = [
    event('event-same-01', '18446744073709551615', 'episode.recorded', { episodeId: 'episode-01' }),
    event('event-same-02', '18446744073709551615', 'episode.recorded', { episodeId: 'episode-02' }),
  ];
  assert.deepEqual(
    protocol.parseSyncPage({ ...validPage, events: sameRevision }).events,
    sameRevision,
  );

  const error = captureProtocolValidationError(
    () => protocol.parseSyncPage({
      ...validPage,
      events: [
        event('event-revision-01', '9007199254740993', 'episode.recorded', { episodeId: 'episode-01' }),
        event('event-revision-02', '9007199254740992', 'episode.recorded', { episodeId: 'episode-02' }),
      ],
    }),
    'Sync page',
  );

  assert.ok(error.issues.some(({ path }) => (
    exactPath(path) === exactPath(['events', 1, 'workspaceRevision'])
  )));
});

test('a unique event after an exact duplicate still enforces revision ordering', () => {
  const duplicate = event('event-order-duplicate', '5', 'episode.recorded', { episodeId: 'episode-duplicate' });
  const error = captureProtocolValidationError(
    () => protocol.parseSyncPage({
      ...validPage,
      events: [
        duplicate,
        event('event-order-six', '6', 'episode.recorded', { episodeId: 'episode-six' }),
        structuredClone(duplicate),
        event('event-order-four', '4', 'episode.recorded', { episodeId: 'episode-four' }),
      ],
    }),
    'Sync page',
  );

  assert.ok(error.issues.some(({ path }) => (
    exactPath(path) === exactPath(['events', 3, 'workspaceRevision'])
  )));
});

test('normal manifest signing key IDs remain valid in revoked events', () => {
  const revoked = event(
    'event-key-revoked',
    '10',
    'signing_key.revoked',
    { keyId: 'primary-2026' },
  );

  assert.deepEqual(protocol.workspaceEventSchema.parse(revoked), revoked);
});

test('sync pages preserve provider order when recordedAt moves backward', () => {
  const events = [
    event('event-time-01', '1', 'episode.recorded', { episodeId: 'episode-01' }, '2026-07-12T03:00:00Z'),
    event('event-time-02', '2', 'episode.recorded', { episodeId: 'episode-02' }, '2026-07-12T02:00:00Z'),
    event('event-time-03', '2', 'episode.recorded', { episodeId: 'episode-03' }, '2026-07-12T01:00:00Z'),
  ];

  assert.deepEqual(protocol.parseSyncPage({ ...validPage, events }).events, events);
});

test('fact supersession cannot point to the same fact', () => {
  const error = captureProtocolValidationError(
    () => protocol.parseSyncPage({
      ...validPage,
      events: [event('event-self', '1', 'fact.superseded', {
        factId: 'fact-same',
        replacedByFactId: 'fact-same',
      })],
    }),
    'Sync page',
  );

  assert.ok(error.issues.some(({ path }) => (
    exactPath(path) === exactPath(['events', 0, 'data', 'replacedByFactId'])
  )));
});

test('proposal.decided rejects pending_review', () => {
  captureProtocolValidationError(
    () => protocol.parseSyncPage({
      ...validPage,
      events: [event('event-pending-decision', '1', 'proposal.decided', {
        proposalId: 'proposal-01',
        status: protocol.ProposalStatus.PENDING_REVIEW,
      })],
    }),
    'Sync page',
  );
});

test('hasMore requires both events and a next cursor', () => {
  for (const page of [
    { ...validPage, events: [], nextCursor: 'next', hasMore: true },
    { ...validPage, nextCursor: null, hasMore: true },
  ]) {
    captureProtocolValidationError(() => protocol.parseSyncPage(page), 'Sync page');
  }

  const completeWithoutCheckpoint = { ...validPage, nextCursor: null };
  assert.deepEqual(protocol.parseSyncPage(completeWithoutCheckpoint), completeWithoutCheckpoint);
  assert.deepEqual(protocol.parseSyncPage(validPage), validPage);
});

test('sync page accepts 500 events and rejects 501', () => {
  const events = Array.from({ length: 501 }, (_, index) => (
    event(`event-boundary-${index}`, String(index), 'episode.recorded', {
      episodeId: `episode-boundary-${index}`,
    })
  ));

  const atBoundary = { ...validPage, events: events.slice(0, 500) };
  assert.equal(protocol.parseSyncPage(atBoundary).events.length, 500);
  captureProtocolValidationError(
    () => protocol.parseSyncPage({ ...validPage, events }),
    'Sync page',
  );
});

test('largest current sync page stays inside the aggregate UTF-8 JSON budget', () => {
  const maximalEvent = event(
    '\u754c'.repeat(128),
    '99999999999999999999',
    'fact.superseded',
    {
      factId: '\u7532'.repeat(128),
      replacedByFactId: '\u4e59'.repeat(128),
    },
    '9999-12-31T23:59:59.999+14:00',
  );
  const page = {
    workspaceId: '\u5de5'.repeat(128),
    events: Array.from({ length: 500 }, () => structuredClone(maximalEvent)),
    nextCursor: '\u6e38'.repeat(512),
    hasMore: true,
  };
  const bytes = utf8JsonByteLength(page);

  assert.ok(bytes > 600_000, bytes);
  assert.ok(bytes < 1_048_576, bytes);
  assert.deepEqual(protocol.parseSyncPage(page), page);
});

test('sync page rejects surrogate payloads even when JSON escaping inflates size', () => {
  const factId = '\ud800'.repeat(128);
  const replacedByFactId = '\ud801'.repeat(128);
  const events = Array.from({ length: 500 }, (_, index) => {
    const prefix = `${index}:`;

    return event(
      `${prefix}${'\ud802'.repeat(128 - prefix.length)}`,
      String(index),
      'fact.superseded',
      { factId, replacedByFactId },
    );
  });
  const page = {
    ...validPage,
    workspaceId: '\ud803'.repeat(128),
    events,
    nextCursor: null,
  };
  const bytes = utf8JsonByteLength(page);

  assert.ok(bytes > 1_048_576, bytes);
  captureProtocolValidationError(() => protocol.parseSyncPage(page), 'Sync page');
});

test('sync fields stay inside shared ID, revision, timestamp, and cursor schemas', () => {
  const validClosurePage = {
    workspaceId: 'workspace-closure',
    events: [event(
      'event-closure',
      '99999999999999999999',
      'episode.recorded',
      { episodeId: 'episode-closure' },
      '2026-07-12T09:30:00.123-05:30',
    )],
    nextCursor: 'cursor/opaque:checkpoint_01',
    hasMore: false,
  };
  assert.deepEqual(protocol.parseSyncPage(validClosurePage), validClosurePage);

  const invalidPages = [
    { ...validClosurePage, workspaceId: ' workspace' },
    { ...validClosurePage, events: [{ ...validClosurePage.events[0], eventId: 'event\u0000id' }] },
    {
      ...validClosurePage,
      events: [{
        ...validClosurePage.events[0],
        data: { episodeId: ' episode-closure' },
      }],
    },
    { ...validClosurePage, events: [{ ...validClosurePage.events[0], workspaceRevision: '01' }] },
    { ...validClosurePage, events: [{ ...validClosurePage.events[0], recordedAt: '2026-07-12T09:30:00' }] },
    { ...validClosurePage, nextCursor: 'cursor with spaces' },
    { ...validClosurePage, nextCursor: 'x'.repeat(513) },
  ];

  for (const page of invalidPages) {
    captureProtocolValidationError(() => protocol.parseSyncPage(page), 'Sync page');
  }
});
