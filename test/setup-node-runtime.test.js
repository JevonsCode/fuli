import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSupportedNodeVersion } from '../src/setup/node-runtime.js';

test('setup accepts the declared minimum Node.js version and newer releases', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.12.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('v25.0.0'));
});

test('setup rejects older or malformed Node.js versions with an actionable message', () => {
  assert.throws(
    () => assertSupportedNodeVersion('24.11.9'),
    /requires Node\.js 24\.12 or later/
  );
  assert.throws(() => assertSupportedNodeVersion('unknown'), /Could not parse Node\.js version/);
});
