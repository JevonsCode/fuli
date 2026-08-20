import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('formal runtime pins production MCP and validation dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.match(pkg.dependencies['@modelcontextprotocol/sdk'], /^\^1\./);
  assert.match(pkg.dependencies.zod, /^\^4\./);
});

test('Graph Provider constrains the OpenAI client to Graphiti-compatible v1', async () => {
  const pyproject = await readFile(
    new URL('../graph-provider/pyproject.toml', import.meta.url),
    'utf8'
  );
  assert.match(pyproject, /"openai>=1\.91,<2"/);
});
