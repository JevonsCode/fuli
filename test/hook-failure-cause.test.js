import assert from 'node:assert/strict';
import test from 'node:test';

import { hookFailureCause } from '../src/agents/lifecycle-message.js';
import { validationError } from '../src/app/application-error.js';
import { FULI_VERSION } from '../src/package-metadata.js';

const IN = ` in FULI ${FULI_VERSION}`;

// rec#85: "the hook failed" said nothing about why.
test('a failed hook names the error code or class, never its message', () => {
  const secret = 'token=synthetic-secret at C:/private/path';
  assert.equal(hookFailureCause(Object.assign(new Error(secret), { code: 'provider_timeout' })), `the hook failed: provider_timeout${IN}`);
  assert.equal(hookFailureCause(new TypeError(secret)), `the hook failed: TypeError${IN}`);
  assert.equal(hookFailureCause(Object.assign(new Error(secret), { code: 'not safe: ' + secret, name: 'Err' })), `the hook failed: Err${IN}`);
  assert.equal(hookFailureCause(undefined), `the hook failed${IN}`);
  assert.equal(hookFailureCause({ code: secret, name: secret }), `the hook failed${IN}`);
});

// rec#85 (11-10): the visible warning names the refusing rule and the hook's
// version, so a report tells an old install from a regression on the spot.
test('a controlled refusal names its rule and the version the hook ran', () => {
  const cause = hookFailureCause(validationError('Task preference scope is immutable; begin a new task for different dimensions'));
  assert.equal(cause, `the hook failed: validation (Task preference scope is immutable; begin a new task for different dimensions)${IN}`);
  const long = hookFailureCause(validationError(`Rule ${'x'.repeat(400)}\nsecond line`));
  assert.ok(long.length < 220);
  assert.doesNotMatch(long, /\n/);
});
