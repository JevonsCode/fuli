import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('capture guidance keeps a resolved temporary scope instead of registering or globalizing it', () => {
  const root = new URL('../skills/capturing-session-knowledge/', import.meta.url);
  const skill = ['SKILL.md', ...readdirSync(new URL('references/', root)).map((name) => 'references/' + name)]
    .map((name) => readFileSync(new URL(name, root), 'utf8')).join('\n');
  assert.match(skill, /temporary project is an active private scope/);
  assert.match(skill, /Do not run this registration flow for an already resolved temporary project/);
  assert.match(skill, /never omit its `personalProjectId` or move its facts to personal-global/);
  assert.match(skill, /workerRuntime\.application/);
  assert.match(skill, /workerRuntime\.sessionId/);
  assert.match(skill, /reporting host/);
});
