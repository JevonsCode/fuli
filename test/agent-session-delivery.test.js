import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { claudeDeliveredTokens } from '../src/agents/claude-code/session-anchors.js';
import { codexLifecycleOutput } from '../src/agents/codex/lifecycle-hook.js';

const SESSION = 'synthetic-claude';
const context = () => ({ taskContextToken: 'fuli-task-synthetic',
  effective_preferences: [{ instruction: 'synthetic preference', preference_key: 'p' }],
  task_guidance: { checkpoint: 'Checkpoint before finishing.' } });

function entryContext(output) {
  const text = output.hookSpecificOutput.additionalContext;
  return { text, context: JSON.parse(text.slice(text.indexOf('\n{') + 1)) };
}

// Claude records each injected context as a hook_additional_context attachment.
const recorded = (text, overrides = {}) => `${JSON.stringify({ type: 'attachment', sessionId: SESSION,
  isSidechain: false, attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptSubmit', content: [text] },
  ...overrides })}\n`;

test('Claude references a group only after the transcript records its full delivery', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-claude-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');
  const input = { session_id: SESSION, cwd: root, prompt: 'Synthetic prompt.', transcript_path: transcript };
  const enter = async () => entryContext(await claudeLifecycleOutput('UserPromptSubmit', input, async () => context()));

  const first = await enter();
  assert.equal(first.context.effective_preferences.length, 1);
  // The entry was produced but never recorded by the host: still full.
  assert.equal((await enter()).context.effective_preferences.length, 1);

  appendFileSync(transcript, recorded(first.text));
  const second = await enter();
  assert.equal(second.context.effective_preferences, undefined);
  assert.equal(second.context.task_guidance.checkpoint, 'Checkpoint before finishing.');

  // A reduced entry never becomes a proof, and compaction clears earlier proofs.
  appendFileSync(transcript, recorded(second.text));
  appendFileSync(transcript, '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}\n');
  appendFileSync(transcript, recorded(second.text));
  assert.equal((await enter()).context.effective_preferences.length, 1);

  // Tokens quoted outside this session's own Fuli entry prove nothing.
  for (const lines of [
    `${JSON.stringify({ type: 'user', sessionId: SESSION, message: { content: first.text } })}\n`,
    recorded(first.text, { sessionId: 'another-session' }),
    recorded(first.text, { isSidechain: true }),
    recorded(`Other hook output quoting ${first.text}`),
    `${recorded(first.text).slice(0, -20)}\n`
  ]) {
    writeFileSync(transcript, lines);
    assert.equal((await enter()).context.effective_preferences.length, 1);
  }
});

test('Claude delivery proof reads only delivered tokens and fails closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-claude-anchor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = 'rules:0123456789ab';
  assert.equal(claudeDeliveredTokens(null, SESSION)(token), false);
  assert.equal(claudeDeliveredTokens(join(root, 'missing.jsonl'), SESSION)(token), false);
  const entry = (sessionDelivery, extra = {}) =>
    recorded(`Fuli task context.\n${JSON.stringify({ session_delivery: sessionDelivery, ...extra })}`);
  const proof = (tail) => claudeDeliveredTokens('synthetic', SESSION, { readTail: () => tail })(token);
  assert.equal(proof(entry({ delivered: [token] })), true);
  assert.equal(proof(entry({ delivered: [] })), false);
  assert.equal(proof(entry({ referenced: { rules: '0123456789ab' } }, { note: token })), false);
  assert.equal(proof(`${entry({ delivered: [token] })}${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`), false);
  assert.equal(claudeDeliveredTokens('synthetic', SESSION, { readTail: () => { throw new Error('unreadable'); } })(token), false);
});

test('Codex has no delivery proof yet, so every entry stays complete', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-codex-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = join(root, 'rollout.jsonl');
  const input = { session_id: 'synthetic-codex', cwd: root, prompt: 'Synthetic prompt.', transcript_path: transcript };
  const first = entryContext(await codexLifecycleOutput('UserPromptSubmit', input, async () => context(),
    { guidanceDirectory: join(root, 'guidance') }));
  writeFileSync(transcript, recorded(first.text, { sessionId: 'synthetic-codex' }));
  const second = entryContext(await codexLifecycleOutput('UserPromptSubmit', input, async () => context(),
    { guidanceDirectory: join(root, 'guidance') }));
  assert.equal(second.context.effective_preferences.length, 1);
  assert.equal(second.context.session_delivery, undefined);
});

test('Claude moves oversized preferences to a file and accepts a full read of it as delivery', async (t) => {
  const { readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'fuli-claude-overflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');
  const many = () => ({ ...context(), effective_preferences: Array.from({ length: 40 }, (_, index) => ({
    instruction: `Synthetic preference ${index}: ${'规则说明'.repeat(60)}`, preference_key: `p${index}`,
    preference_scope: 'global' })) });
  const input = { session_id: SESSION, cwd: root, prompt: 'Synthetic prompt.', transcript_path: transcript };
  const enter = async () => entryContext(await claudeLifecycleOutput('UserPromptSubmit', input, async () => many(),
    { guidanceDirectory: join(root, 'guidance') }));

  const first = await enter();
  assert.ok(first.text.length <= 9500);
  const file = first.context.effective_preferences_file;
  assert.equal(first.context.effective_preferences, undefined);
  assert.equal(file.count, 40);
  assert.equal(file.index[3].key, 'p3');
  assert.match(file.must_read, /Read this file in full/);
  assert.match(readFileSync(file.file, 'utf8'), /## 40\. p39\n\nSynthetic preference 39/);
  assert.equal(first.context.session_delivery.delivered.some((token) => token.startsWith('preferences:')), false);

  const read = (id, extra = {}) => `${JSON.stringify({ type: 'assistant', sessionId: SESSION, isSidechain: false,
    message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file.file, ...extra } }] } })}\n`;
  const result = (id, isError = false) => `${JSON.stringify({ type: 'user', sessionId: SESSION, isSidechain: false,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'preferences' }] } })}\n`;
  appendFileSync(transcript, recorded(first.text));
  // A failed or partial read is not delivery.
  appendFileSync(transcript, read('read-1') + result('read-1', true) + read('read-2', { limit: 10 }) + result('read-2'));
  assert.ok((await enter()).context.effective_preferences_file);
  appendFileSync(transcript, read('read-3') + result('read-3'));
  const later = await enter();
  assert.equal(later.context.effective_preferences_file, undefined);
  assert.equal(later.context.effective_preferences, undefined);
  assert.equal(later.context.effective_preferences_count, 40);
  assert.deepEqual(Object.keys(later.context.session_delivery.referenced).sort(), ['identity', 'preferences', 'rules']);
});
