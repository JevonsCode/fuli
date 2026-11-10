import assert from 'node:assert/strict';
import test from 'node:test';

import { hookFailureCause } from '../src/agents/lifecycle-message.js';
import { validationError } from '../src/app/application-error.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
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

// A Provider refusal relays the Provider's own detail, which may echo what
// was sent (rec#85, DOT 11-10): the hook says only its HTTP status.
test('a Provider refusal says its HTTP status, never its detail', () => {
  const windows = String.raw`C:\Users\someone\secret.txt`;
  const unc = String.raw`\\server\share\notes.md`;
  const opaque = 'sk-synthetic-' + 'a1b2c3d4'.repeat(6);
  const detail = `Value error at ${windows} token=${opaque} ${unc}`;
  // The fixture really carries a Windows path, a UNC path and a long opaque value.
  assert.ok(detail.includes('C:\\Users\\someone') && detail.includes('\\\\server\\share') && opaque.length > 40);
  const causes = [
    [hookFailureCause(new ProviderRequestError(detail, { status: 422 })), `the hook failed: provider_error (HTTP 422)${IN}`],
    [hookFailureCause(new ProviderRequestError(detail)), `the hook failed: provider_error${IN}`],
    [hookFailureCause(new ProviderRequestError(detail, { status: 503, code: 'provider_http_5xx' })), `the hook failed: provider_http_5xx (HTTP 503)${IN}`]
  ];
  for (const [cause, expected] of causes) {
    assert.equal(cause, expected);
    for (const secret of [windows, unc, opaque, 'someone', 'server']) assert.ok(!cause.includes(secret), secret);
  }
});
