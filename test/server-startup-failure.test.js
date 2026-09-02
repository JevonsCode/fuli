import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createServer } from '../src/server.js';

test('invalid system configuration closes the real database opened by the owned application', async (t) => {
  // Only native SQLite I/O is observed; application/system construction is real.
  // No Provider request or model process is needed to construct the application.
  const directory = mkdtempSync(join(tmpdir(), 'fuli-startup-cleanup-'));
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({ version: 1,
    personal: { providerUrl: 'http://127.0.0.1:1', accessToken: 'synthetic-fixture',
      principalId: 'synthetic-principal', spaceId: 'synthetic-space' }, workspaces: [] }));
  writeFileSync(join(directory, 'runtime-settings.json'), JSON.stringify({ version: 999 }));
  const opened = new Set();
  const closed = new Set();
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'exec', function (...args) {
    opened.add(this);
    return Reflect.apply(exec, this, args);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function (...args) {
    const result = Reflect.apply(close, this, args);
    closed.add(this);
    return result;
  });
  try {
    await assert.rejects(createServer({ runtimeConfigPath, port: 0 }),
      /Unsupported runtime settings version/);
    assert.equal(opened.size, 1, 'the test must exercise an actually opened database');
    assert.ok(existsSync(join(directory, 'employees/data/management.sqlite')));
    assert.deepEqual(closed, opened, 'startup rejection must await owned database closure');
  } finally {
    // Keep the failing (RED) version safe too; only this test's databases are retained.
    for (const database of opened) if (!closed.has(database)) Reflect.apply(close, database, []);
    rmSync(directory, { recursive: true, force: true });
  }
});
