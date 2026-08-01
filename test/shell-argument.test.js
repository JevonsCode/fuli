import assert from 'node:assert/strict';
import test from 'node:test';

import { quoteShellArgument } from '../src/cli/shell-argument.js';

test('shell arguments are quoted without executing their contents', () => {
  assert.equal(
    quoteShellArgument('C:\\data path\\runtime.json', 'win32'),
    '"C:\\data path\\runtime.json"'
  );
  assert.throws(
    () => quoteShellArgument('C:\\bad"path', 'win32'),
    /double quote/
  );
  assert.equal(
    quoteShellArgument("/tmp/user's runtime.json", 'linux'),
    "'/tmp/user'\\''s runtime.json'"
  );
});
