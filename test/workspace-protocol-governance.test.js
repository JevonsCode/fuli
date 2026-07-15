import assert from 'node:assert/strict';
import test from 'node:test';

import * as protocol from '../src/workspace-protocol/index.js';

const validJoinRequest = {
  requestId: 'join-request-01',
  workspaceId: 'workspace-01',
  requesterId: 'person-01',
  message: 'I can maintain the evidence index.',
  createdAt: '2026-07-12T09:30:00+08:00',
  status: 'pending',
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

test('governance contract exposes only its planned public API additions', () => {
  for (const exportName of [
    'joinRequestSchema',
    'joinDecisionSchema',
    'proposalDecisionSchema',
    'parseJoinRequest',
    'parseJoinDecision',
    'parseProposalDecision',
  ]) {
    assert.notEqual(protocol[exportName], undefined, exportName);
  }

  for (const privateExport of [
    'governanceReasonSchema',
    'joinRequestStatusSchema',
    'proposalDecisionValueSchema',
  ]) {
    assert.equal(protocol[privateExport], undefined, privateExport);
  }
});

test('join requests accept all three statuses and nullable messages', () => {
  for (const status of ['pending', 'approved', 'rejected']) {
    const request = { ...validJoinRequest, status };
    assert.deepEqual(protocol.joinRequestSchema.parse(request), request);
    assert.deepEqual(protocol.parseJoinRequest(request), request);
  }

  const withoutMessage = { ...validJoinRequest, message: null };
  assert.deepEqual(protocol.parseJoinRequest(withoutMessage), withoutMessage);
});

test('join decisions accept approve and reject', () => {
  for (const decision of ['approve', 'reject']) {
    const value = { decision, reason: 'Reviewed by a maintainer.' };
    assert.deepEqual(protocol.joinDecisionSchema.parse(value), value);
    assert.deepEqual(protocol.parseJoinDecision(value), value);
  }
});

test('proposal decisions accept every explicit human outcome', () => {
  for (const decision of [
    'accept_new',
    'keep_current',
    'keep_both',
    'request_source',
  ]) {
    const value = { decision, reason: 'Decision follows the available sources.' };
    assert.deepEqual(protocol.proposalDecisionSchema.parse(value), value);
    assert.deepEqual(protocol.parseProposalDecision(value), value);
  }
});

test('governance decisions reject let_ai_decide', () => {
  captureProtocolValidationError(
    () => protocol.parseJoinDecision({
      decision: 'let_ai_decide',
      reason: 'Delegate this decision.',
    }),
    'Join decision',
  );
  captureProtocolValidationError(
    () => protocol.parseProposalDecision({
      decision: 'let_ai_decide',
      reason: 'Delegate this decision.',
    }),
    'Proposal decision',
  );
});

test('governance objects reject metadata, raw content, and unknown statuses', () => {
  const invalidValues = [
    [() => protocol.parseJoinRequest({ ...validJoinRequest, metadata: { source: 'private' } }), 'Join request'],
    [() => protocol.parseJoinRequest({ ...validJoinRequest, status: 'withdrawn' }), 'Join request'],
    [() => protocol.parseJoinDecision({ decision: 'approve', reason: 'Reviewed.', rawContent: 'private' }), 'Join decision'],
    [() => protocol.parseProposalDecision({ decision: 'keep_current', reason: 'Reviewed.', metadata: {} }), 'Proposal decision'],
  ];

  for (const [run, label] of invalidValues) {
    captureProtocolValidationError(run, label);
  }
});

test('governance semantic message and reasons reject unsafe text', () => {
  const invalidText = [
    '',
    '   ',
    ' leading',
    'trailing ',
    'embedded\u0000nul',
    'embedded\u007fdel',
    '\u200b',
    '\u202e',
    'embedded\u200bformat',
    'x'.repeat(501),
  ];

  for (const text of invalidText) {
    captureProtocolValidationError(
      () => protocol.parseJoinRequest({ ...validJoinRequest, message: text }),
      'Join request',
    );
    captureProtocolValidationError(
      () => protocol.parseJoinDecision({ decision: 'approve', reason: text }),
      'Join decision',
    );
    captureProtocolValidationError(
      () => protocol.parseProposalDecision({ decision: 'keep_both', reason: text }),
      'Proposal decision',
    );
  }
});

test('governance semantic text preserves valid internal whitespace at the boundary', () => {
  const text = `A${'x'.repeat(497)} B`;
  assert.equal(text.length, 500);

  assert.equal(
    protocol.parseJoinRequest({ ...validJoinRequest, message: text }).message,
    text,
  );
  assert.equal(
    protocol.parseJoinDecision({ decision: 'approve', reason: text }).reason,
    text,
  );
  assert.equal(
    protocol.parseProposalDecision({ decision: 'request_source', reason: text }).reason,
    text,
  );
});

test('join request fields stay inside shared ID and timestamp schemas', () => {
  const validBoundary = {
    ...validJoinRequest,
    requestId: 'r'.repeat(128),
    workspaceId: 'w'.repeat(128),
    requesterId: 'p'.repeat(128),
    createdAt: '2026-07-12T09:30:00.123-05:30',
  };
  assert.deepEqual(protocol.parseJoinRequest(validBoundary), validBoundary);

  const invalidRequests = [
    { ...validJoinRequest, requestId: ' request' },
    { ...validJoinRequest, workspaceId: 'workspace\u0000id' },
    { ...validJoinRequest, requesterId: 'x'.repeat(129) },
    { ...validJoinRequest, createdAt: '2026-07-12T09:30:00' },
    { ...validJoinRequest, createdAt: '2026-07-12T09:30:00.1234Z' },
  ];

  for (const request of invalidRequests) {
    captureProtocolValidationError(
      () => protocol.parseJoinRequest(request),
      'Join request',
    );
  }
});

test('governance parser labels are exact and independent of Zod wording', () => {
  for (const [run, label] of [
    [() => protocol.parseJoinRequest({}), 'Join request'],
    [() => protocol.parseJoinDecision({}), 'Join decision'],
    [() => protocol.parseProposalDecision({}), 'Proposal decision'],
  ]) {
    const error = captureProtocolValidationError(run, label);
    assert.equal(Array.isArray(error.issues), true);
  }
});
