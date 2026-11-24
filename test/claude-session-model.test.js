import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionModel } from '../src/agents/claude-code/session-model.js';

// Synthetic transcripts only.
async function transcript(lines) {
  const folder = await mkdtemp(join(tmpdir(), 'fuli-claude-model-'));
  const path = join(folder, 'session.jsonl');
  await writeFile(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  return { path, done: () => rm(folder, { recursive: true, force: true }) };
}

test('the model of a Claude session is the one on its newest assistant message', async () => {
  const file = await transcript([
    { type: 'user', message: { content: 'synthetic' } },
    { type: 'assistant', message: { model: 'synthetic-model-a' } },
    { type: 'assistant', message: { model: 'synthetic-model-b' } },
    { type: 'assistant', message: { model: '<synthetic>' } },
    { type: 'user', message: { content: 'next' } },
    'not json'
  ]);
  try {
    assert.equal(await claudeSessionModel(file.path), 'synthetic-model-b');
  } finally { await file.done(); }
});

test('a session with no answer yet, no transcript or an unreadable one has no model', async () => {
  const file = await transcript([{ type: 'user', message: { content: 'first prompt' } }]);
  try {
    assert.equal(await claudeSessionModel(file.path), null);
    assert.equal(await claudeSessionModel(join(tmpdir(), 'fuli-missing-transcript.jsonl')), null);
    assert.equal(await claudeSessionModel(undefined), null);
  } finally { await file.done(); }
});
