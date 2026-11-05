// The Claude Code transcript format probe, through the doctor's port. Synthetic
// only: transcript lines this test writes under a temporary CLAUDE_CONFIG_DIR.
// No real ~/.claude, FULI data directory, port or client is used.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeTranscriptFormat } from '../../../src/agents/claude-code/transcript-format-probe.js';
import { createTranscriptFormatProbe } from '../../../src/agents/transcript-format-registry.js';

const SESSION = '00000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-11-06T08:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function claudeHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-claude-format-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function transcript(root, records, { name = SESSION, changedAt = NOW } = {}) {
  const directory = join(root, 'projects', 'synthetic-project');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n');
  await utimes(path, new Date(changedAt), new Date(changedAt));
  return path;
}

const probe = (root) => createTranscriptFormatProbe({ formats: [claudeTranscriptFormat], env: { CLAUDE_CONFIG_DIR: root },
  now: () => NOW });

const user = (text) => ({ type: 'user', sessionId: SESSION, uuid: 'u', message: { role: 'user', content: text } });
const assistant = (text) => ({ type: 'assistant', sessionId: SESSION, uuid: 'a',
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'synthetic' }, { type: 'text', text }] } });

test('a Claude Code transcript the parser reads is counted, with no text, path or session leaving the probe', async (t) => {
  const root = await claudeHome(t);
  await transcript(root, [
    { type: 'file-history-snapshot', messageId: 'm' },
    user('synthetic question'),
    assistant('synthetic answer'),
    { type: 'assistant', sessionId: SESSION, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
    { type: 'user', sessionId: SESSION, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'synthetic' }] } },
    // Thinking alone is left out by design, not a format change.
    { type: 'assistant', sessionId: SESSION, message: { content: [{ type: 'thinking', thinking: 'synthetic' }] } },
    { type: 'system', subtype: 'compact_boundary', sessionId: SESSION }
  ]);
  const answer = await probe(root)();
  assert.deepEqual(answer, { 'claude-code': { readable: true, recognized: 4, total: 4 } });
  assert.doesNotMatch(JSON.stringify(answer), /synthetic|0000-4000|projects/);
});

test('a changed Claude Code turn reads as a line the parser no longer understands', async (t) => {
  const root = await claudeHome(t);
  const changed = (text) => ({ type: 'user', sessionId: SESSION, message: { role: 'user', body: text } });
  await transcript(root, [user('synthetic old line'), ...Array.from({ length: 6 }, (_, index) => changed(`synthetic ${index}`)), 'not json at all']);
  assert.deepEqual(await probe(root)(), { 'claude-code': { readable: true, recognized: 1, total: 8 } });
});

test('a record type Claude Code added says nothing about the format', async (t) => {
  const root = await claudeHome(t);
  await transcript(root, [user('synthetic line'), ...Array.from({ length: 9 }, () => ({ type: 'brand-new-metadata' }))]);
  assert.deepEqual(await probe(root)(), { 'claude-code': { readable: true, recognized: 1, total: 1 } });
});

test('a long transcript with no turn at all means the turns were renamed', async (t) => {
  const root = await claudeHome(t);
  await transcript(root, Array.from({ length: 25 }, (_, index) => ({ kind: 'turn', speaker: 'user', body: `synthetic ${index}` })));
  assert.deepEqual(await probe(root)(), { 'claude-code': { readable: true, recognized: 0, total: 25 } });
});

test('without a transcript changed this week Claude Code answers no_transcript', async (t) => {
  const root = await claudeHome(t);
  assert.deepEqual(await probe(root)(), { 'claude-code': { readable: false, reason: 'no_transcript' } });
  await transcript(root, [user('synthetic stale')], { changedAt: NOW - 8 * DAY });
  assert.deepEqual(await probe(root)(), { 'claude-code': { readable: false, reason: 'no_transcript' } });
});

test('the newest transcript is probed, and only its last 256 KB', async (t) => {
  const root = await claudeHome(t);
  await transcript(root, Array.from({ length: 6 }, () => ({ kind: 'changed' })), { name: 'older', changedAt: NOW - DAY });
  // A long run of readable lines, then 300 KB of changed ones: the tail holds only changed lines.
  const filler = { kind: 'changed', pad: 'x'.repeat(1000) };
  await transcript(root, [...Array.from({ length: 50 }, () => user('synthetic')), ...Array.from({ length: 300 }, () => filler)]);
  const { 'claude-code': answer } = await probe(root)();
  assert.equal(answer.recognized, 0);
  assert.ok(answer.total > 200 && answer.total < 300, `counted ${answer.total} lines`);
});

test('the probe answer is kept for ten minutes', async (t) => {
  const root = await claudeHome(t);
  let now = NOW;
  const read = createTranscriptFormatProbe({ formats: [claudeTranscriptFormat], env: { CLAUDE_CONFIG_DIR: root }, now: () => now });
  assert.equal((await read())['claude-code'].reason, 'no_transcript');
  await transcript(root, [user('synthetic')]);
  now += 9 * 60 * 1000;
  assert.equal((await read())['claude-code'].reason, 'no_transcript');
  now += 2 * 60 * 1000;
  assert.deepEqual((await read())['claude-code'], { readable: true, recognized: 1, total: 1 });
});
