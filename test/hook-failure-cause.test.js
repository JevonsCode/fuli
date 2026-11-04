import assert from 'node:assert/strict';
import test from 'node:test';

import { hookFailureCause } from '../src/agents/lifecycle-message.js';

// rec#85: "the hook failed" said nothing about why.
test('a failed hook names the error code or class, never its message', () => {
  const secret = 'token=synthetic-secret at C:/private/path';
  assert.equal(hookFailureCause(Object.assign(new Error(secret), { code: 'provider_timeout' })), 'the hook failed: provider_timeout');
  assert.equal(hookFailureCause(new TypeError(secret)), 'the hook failed: TypeError');
  assert.equal(hookFailureCause(Object.assign(new Error(secret), { code: 'not safe: ' + secret, name: 'Err' })), 'the hook failed: Err');
  assert.equal(hookFailureCause(undefined), 'the hook failed');
  assert.equal(hookFailureCause({ code: secret, name: secret }), 'the hook failed');
});
