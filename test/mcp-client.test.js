import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectMcp } from '../test-support/mcp-client.js';

test('connectMcp closes client, transport, and probe after startup failure', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-mcp-failed-connect-')), 'context.db');
  let connection;
  let failure;
  try {
    connection = await connectMcp(dbPath, {
      serverPath: 'test-support/does-not-exist.js'
    });
    assert.fail('connectMcp unexpectedly connected');
  } catch (error) {
    failure = error;
  } finally {
    await connection?.close();
  }

  assert.ok(failure?.cleanup);
  assert.match(failure.cleanup.stderr, /does-not-exist|cannot find module/i);
  assert.equal(processExists(failure.cleanup.probePid), false);
  assert.equal(processExists(failure.cleanup.childPid), false);
  assert.notEqual(failure.cleanup.status.code, 0);
});

function processExists(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
