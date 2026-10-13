import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { claudeDeliveredTokens } from '../src/agents/claude-code/session-anchors.js';
import { codexLifecycleOutput } from '../src/agents/codex/lifecycle-hook.js';

const context = () => ({ taskContextToken: 'fuli-task-synthetic',
  effective_preferences: [{ instruction: 'synthetic preference', preference_key: 'p' }],
  task_guidance: { checkpoint: 'Checkpoint before finishing.' } });

function entryContext(output) {
  const text = output.hookSpecificOutput.additionalContext;
  return { text, context: JSON.parse(text.slice(text.indexOf('\n{') + 1)) };
}

// Claude records each injected context as a hook_additional_context attachment.
const recorded = (text) => `${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text] } })}\n`;

test('Claude references a group only after the transcript records its full delivery', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-claude-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');
  const input = { session_id: 'synthetic-claude', cwd: root, prompt: 'Synthetic prompt.', transcript_path: transcript };
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

  // Delivery tokens quoted outside a hook record prove nothing.
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: first.text } })}\n`);
  assert.equal((await enter()).context.effective_preferences.length, 1);
});

test('Claude delivery proof reads only the recent transcript and fails closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-claude-anchor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(claudeDeliveredTokens(null)('rules:0123456789ab'), false);
  assert.equal(claudeDeliveredTokens(join(root, 'missing.jsonl'))('rules:0123456789ab'), false);
  const tail = recorded('{"session_delivery":{"delivered":["rules:0123456789ab"]}}');
  assert.equal(claudeDeliveredTokens('synthetic', { readTail: () => tail })('rules:0123456789ab'), true);
  assert.equal(claudeDeliveredTokens('synthetic', { readTail: () => { throw new Error('unreadable'); } })('rules:0123456789ab'), false);
});

test('Codex has no delivery proof yet, so every entry stays complete', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-codex-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transcript = join(root, 'rollout.jsonl');
  const input = { session_id: 'synthetic-codex', cwd: root, prompt: 'Synthetic prompt.', transcript_path: transcript };
  const first = entryContext(await codexLifecycleOutput('UserPromptSubmit', input, async () => context(),
    { guidanceDirectory: join(root, 'guidance') }));
  writeFileSync(transcript, recorded(first.text));
  const second = entryContext(await codexLifecycleOutput('UserPromptSubmit', input, async () => context(),
    { guidanceDirectory: join(root, 'guidance') }));
  assert.equal(second.context.effective_preferences.length, 1);
  assert.equal(second.context.session_delivery, undefined);
});
