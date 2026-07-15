import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationError,
  ApplicationErrorCode
} from '../src/app/application-error.js';
import { mapHttpError } from '../src/http/error-mapping.js';

test('HTTP error mapping treats application not-found and validation errors as bad requests', () => {
  for (const code of [ApplicationErrorCode.NOT_FOUND, ApplicationErrorCode.VALIDATION]) {
    const mapped = mapHttpError(new ApplicationError(code, 'invalid request'));
    assert.deepEqual(mapped, { status: 400, body: { error: 'invalid request' } });
  }
});

test('HTTP error mapping treats malformed JSON as a bad request', () => {
  const mapped = mapHttpError(new SyntaxError('Unexpected end of JSON input'));
  assert.deepEqual(mapped, { status: 400, body: { error: 'Malformed JSON' } });
});

test('HTTP error mapping keeps unexpected failures internal', () => {
  const mapped = mapHttpError(new Error('database unavailable'));
  assert.deepEqual(mapped, { status: 500, body: { error: 'Internal server error' } });
});
