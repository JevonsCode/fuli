// The Codex transcript format probe, through the doctor's port. Synthetic only:
// rollout lines this test writes under a temporary CODEX_HOME. No real ~/.codex,
// FULI data directory, port or client is used.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexTranscriptFormat } from '../../../src/agents/codex/transcript-format-probe.js';
import { createTranscriptFormatProbe } from '../../../src/agents/transcript-format-registry.js';

const SESSION = 'synthetic-codex-session';
const NOW = Date.parse('2026-11-06T08:00:00.000Z');

async function codexHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-codex-format-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function rollout(root, records) {
  const directory = join(root, 'sessions', '2026', '11', '06');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-11-06T08-00-00-${SESSION}.jsonl`);
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await utimes(path, new Date(NOW), new Date(NOW));
}

const probe = (root) => createTranscriptFormatProbe({ formats: [codexTranscriptFormat], env: { CODEX_HOME: root }, now: () => NOW });

const item = (payload) => ({ timestamp: '2026-11-06T08:00:00.000Z', type: 'response_item', payload });
const message = (role, text) => item({ type: 'message', role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });

test('a Codex rollout the parser reads is counted, with no text, path or session leaving the probe', async (t) => {
  const root = await codexHome(t);
  await rollout(root, [
    { type: 'session_meta', payload: { id: SESSION } },
    { type: 'turn_context', payload: { cwd: 'synthetic' } },
    message('user', 'synthetic question'),
    { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic question' } },
    item({ type: 'reasoning', summary: [] }),
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'synthetic' }] }),
    item({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }),
    item({ type: 'function_call_output', call_id: 'c1', output: 'synthetic' }),
    message('assistant', 'synthetic answer'),
    { type: 'compacted', payload: { message: 'synthetic summary' } }
  ]);
  const answer = await probe(root)();
  assert.deepEqual(answer, { codex: { readable: true, recognized: 5, total: 5 } });
  assert.doesNotMatch(JSON.stringify(answer), /synthetic|sessions|rollout/);
});

test('a changed Codex format reads as lines the parser no longer understands', async (t) => {
  const root = await codexHome(t);
  const changed = (text) => ({ type: 'response_entry', entry: { kind: 'chat', author: 'user', parts: [text] } });
  await rollout(root, [{ type: 'session_meta', payload: { id: SESSION } }, message('user', 'synthetic old'),
    ...Array.from({ length: 5 }, (_, index) => changed(`synthetic ${index}`))]);
  assert.deepEqual(await probe(root)(), { codex: { readable: true, recognized: 1, total: 6 } });
});

test('without a rollout Codex answers no_transcript', async (t) => {
  const root = await codexHome(t);
  assert.deepEqual(await probe(root)(), { codex: { readable: false, reason: 'no_transcript' } });
});
