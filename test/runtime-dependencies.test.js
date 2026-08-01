import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('formal runtime pins production MCP and validation dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.match(pkg.dependencies['@modelcontextprotocol/sdk'], /^\^1\./);
  assert.match(pkg.dependencies.zod, /^\^4\./);
});
