import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Database from 'better-sqlite3';

test('formal runtime pins production storage and MCP dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.match(pkg.dependencies['better-sqlite3'], /^\^12\./);
  assert.match(pkg.dependencies['@modelcontextprotocol/sdk'], /^\^1\./);
  assert.match(pkg.dependencies.zod, /^\^4\./);
});

test('better-sqlite3 opens an in-memory database', () => {
  const db = new Database(':memory:');
  assert.equal(db.prepare('select 1 as ok').get().ok, 1);
  db.close();
});
