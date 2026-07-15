import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  FactCertainty,
  FactState,
  parseProtocolValue,
  ProposalStatus,
  ProtocolErrorCode,
  ProtocolValidationError,
  ProviderCapability,
  protocolErrorResponseSchema,
  WORKSPACE_PROTOCOL_VERSION,
  WorkspaceRole,
  WorkspaceVisibility,
} from '../src/workspace-protocol/index.js';

const validProtocolErrorBody = {
  code: ProtocolErrorCode.VALIDATION_FAILED,
  message: 'Workspace visibility is invalid',
  traceId: 'trace-123',
};

function captureProtocolValidationError(schema, value) {
  try {
    parseProtocolValue(schema, value, 'protocol error response');
    assert.fail('Expected protocol validation to fail');
  } catch (error) {
    assert.equal(error instanceof ProtocolValidationError, true);
    return error;
  }
}

test('workspace protocol constants expose the version and frozen vocabularies', () => {
  assert.equal(WORKSPACE_PROTOCOL_VERSION, '1');

  const vocabularies = [
    [ProviderCapability, ['query', 'sync', 'publish', 'review']],
    [WorkspaceVisibility, ['public', 'unlisted', 'private']],
    [WorkspaceRole, ['member', 'maintainer']],
    [ProposalStatus, ['effective', 'pending_review', 'rejected']],
    [FactState, ['active', 'superseded', 'retracted', 'disputed']],
    [FactCertainty, ['confirmed', 'known_unknown']],
  ];

  for (const [vocabulary, values] of vocabularies) {
    assert.equal(Object.isFrozen(vocabulary), true);
    assert.deepEqual(Object.values(vocabulary), values);
  }
});

test('protocol error codes are frozen and expose all machine codes', () => {
  assert.equal(Object.isFrozen(ProtocolErrorCode), true);
  assert.deepEqual(Object.values(ProtocolErrorCode), [
    'AUTHENTICATION_REQUIRED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'IDEMPOTENCY_CONFLICT',
    'REVISION_CONFLICT',
    'CURSOR_EXPIRED',
    'RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'PROTOCOL_INCOMPATIBLE',
  ]);
});

test('strict protocol error body accepts required validation failure fields', () => {
  assert.deepEqual(
    parseProtocolValue(
      protocolErrorResponseSchema,
      validProtocolErrorBody,
      'protocol error response',
    ),
    validProtocolErrorBody,
  );
});

test('strict protocol error body rejects stack with ProtocolValidationError', () => {
  const body = {
    ...validProtocolErrorBody,
    stack: 'internal details',
  };
  const error = captureProtocolValidationError(protocolErrorResponseSchema, body);

  assert.equal(error instanceof TypeError, true);
  assert.equal(error.name, 'ProtocolValidationError');
  assert.equal(error.message, 'protocol error response failed protocol validation');
  assert.equal(error.issues.length, 1);
  assert.equal(error.issues[0].code, 'unrecognized_keys');
  assert.deepEqual(error.issues[0].path, []);
  assert.ok(error.issues[0].message.length <= 256);
});

test('validation issues are bounded, defensively copied, and frozen', () => {
  const sourcePath = [
    's'.repeat(200),
    42,
    { toString: () => 'o'.repeat(200) },
  ];
  const error = new ProtocolValidationError('custom value', [
    {
      code: 'custom',
      path: sourcePath,
      message: 'm'.repeat(300),
      internal: 'must not escape',
    },
  ]);

  sourcePath[0] = 'changed after projection';

  assert.equal(error.message, 'custom value failed protocol validation');
  assert.deepEqual(Object.keys(error.issues[0]), ['code', 'path', 'message']);
  assert.deepEqual(error.issues[0].path, [
    's'.repeat(128),
    42,
    'o'.repeat(128),
  ]);
  assert.equal(error.issues[0].message, 'Value violates a protocol constraint');
  assert.equal(Object.isFrozen(error.issues), true);
  assert.equal(Object.isFrozen(error.issues[0]), true);
  assert.equal(Object.isFrozen(error.issues[0].path), true);
});

test('validation issues redact Zod messages and unknown input field names', () => {
  const secretField = ['token=sk', '_live_', 'SECRET'].join('');
  const error = captureProtocolValidationError(
    z.strictObject({ allowed: z.string() }),
    { allowed: 'yes', [secretField]: true },
  );
  const serializedIssues = JSON.stringify(error.issues);

  assert.equal(error.message.includes(secretField), false);
  assert.equal(serializedIssues.includes(secretField), false);
  assert.deepEqual(error.issues[0], {
    code: 'unrecognized_keys',
    path: [],
    message: 'Unexpected field',
  });
});

test('validation issue messages are stable for built-in and custom codes', () => {
  const cases = [
    [z.strictObject({ allowed: z.string() }), { allowed: 'yes', extra: true }, 'unrecognized_keys', 'Unexpected field'],
    [z.string(), 42, 'invalid_type', 'Invalid value type'],
    [z.string().min(2), 'x', 'too_small', 'Value is below the allowed minimum'],
    [z.string().max(1), 'xx', 'too_big', 'Value exceeds the allowed maximum'],
    [z.string().regex(/^ok$/u), 'no', 'invalid_format', 'Value has an invalid format'],
    [z.enum(['ok']), 'no', 'invalid_value', 'Value is not allowed'],
    [z.union([z.string(), z.number()]), {}, 'invalid_union', 'Value does not match any allowed shape'],
    [z.string().refine(() => false, { message: 'input-derived detail' }), 'value', 'custom', 'Value violates a protocol constraint'],
  ];

  for (const [schema, value, code, message] of cases) {
    const error = captureProtocolValidationError(schema, value);

    assert.equal(error.issues[0].code, code);
    assert.equal(error.issues[0].message, message);
  }

  for (const code of ['future_issue_code', 'toString']) {
    const fallback = new ProtocolValidationError('custom value', [{
      code,
      path: [],
      message: 'must not escape',
    }]);

    assert.equal(fallback.issues[0].message, 'Value failed protocol validation');
  }
});

test('validation issue codes remain bounded', () => {
  const error = new ProtocolValidationError('custom value', [{
    code: 'x'.repeat(200),
    path: [],
    message: 'must not escape',
  }]);

  assert.equal(error.issues[0].code, 'x'.repeat(64));
});

test('long unknown field names produce a fixed-budget issue projection', () => {
  const pathSegments = Array.from(
    { length: 18 },
    (_, index) => `${index}-${'p'.repeat(200)}`,
  );
  const unknownField = `unknown-${'u'.repeat(2_000)}`;
  let schema = z.strictObject({ allowed: z.string() });
  let value = { allowed: 'yes', [unknownField]: true };

  for (const segment of pathSegments.toReversed()) {
    schema = z.strictObject({ [segment]: schema });
    value = { [segment]: value };
  }

  const error = captureProtocolValidationError(schema, value);
  const [issue] = error.issues;

  assert.equal(issue.code, 'unrecognized_keys');
  assert.equal(issue.path.length, 16);
  assert.ok(issue.path.every((segment) => segment.length <= 128));
  assert.ok(issue.message.length <= 256);
  assert.ok(JSON.stringify(error.issues).length <= 2_600);
});

test('validation errors retain at most 20 issues', () => {
  const shape = Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [`field${index}`, z.string()]),
  );
  const error = captureProtocolValidationError(z.strictObject(shape), {});

  assert.equal(error.issues.length, 20);
});

test('retryAfterSeconds accepts inclusive bounds and rejects invalid values', () => {
  for (const retryAfterSeconds of [1, 86_400]) {
    const body = { ...validProtocolErrorBody, retryAfterSeconds };
    assert.deepEqual(
      parseProtocolValue(protocolErrorResponseSchema, body, 'protocol error response'),
      body,
    );
  }

  for (const retryAfterSeconds of [0, 86_401, 1.5]) {
    captureProtocolValidationError(protocolErrorResponseSchema, {
      ...validProtocolErrorBody,
      retryAfterSeconds,
    });
  }
});

test('protocol error message and trace ID enforce their maximum lengths', () => {
  for (const [field, validLength, invalidLength] of [
    ['message', 500, 501],
    ['traceId', 128, 129],
  ]) {
    const validBody = { ...validProtocolErrorBody, [field]: 'x'.repeat(validLength) };
    assert.deepEqual(
      parseProtocolValue(
        protocolErrorResponseSchema,
        validBody,
        'protocol error response',
      ),
      validBody,
    );
    captureProtocolValidationError(protocolErrorResponseSchema, {
      ...validProtocolErrorBody,
      [field]: 'x'.repeat(invalidLength),
    });
  }
});

test('protocol error trace IDs reject whitespace and Unicode category C without echoing input', () => {
  const validTraceId = 'trace-ID_123';

  assert.equal(
    parseProtocolValue(
      protocolErrorResponseSchema,
      { ...validProtocolErrorBody, traceId: validTraceId },
      'protocol error response',
    ).traceId,
    validTraceId,
  );

  for (const traceId of [
    'trace id',
    'trace\u202eid',
    'trace\ud800id',
    'trace\ue000id',
  ]) {
    const error = captureProtocolValidationError(
      protocolErrorResponseSchema,
      { ...validProtocolErrorBody, traceId },
    );
    const serializedError = JSON.stringify({
      message: error.message,
      issues: error.issues,
    });

    assert.equal(serializedError.includes(traceId), false);
  }
});

test('protocol error messages reject Unicode category C and preserve natural language', () => {
  for (const message of ['\u4e2d\u6587 \u9519\u8bef', '\u062e\u0637\u0623 \u0627\u0644\u062a\u062d\u0642\u0642']) {
    assert.equal(
      parseProtocolValue(
        protocolErrorResponseSchema,
        { ...validProtocolErrorBody, message },
        'protocol error response',
      ).message,
      message,
    );
  }

  captureProtocolValidationError(
    protocolErrorResponseSchema,
    { ...validProtocolErrorBody, message: 'unsafe\u202emessage' },
  );
});
