import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeLifecycleOutput } from '../src/agents/claude-code/lifecycle-hook.js';
import { CLAUDE_COMPACTION_PATTERN } from '../src/agents/claude-code/conversation-transcript.js';
import { codexLifecycleOutput } from '../src/agents/codex/lifecycle-hook.js';
import { CODEX_COMPACTION_PATTERN } from '../src/agents/codex/conversation-transcript.js';

const context = () => ({ taskContextToken: 'fuli-task-synthetic',
  effective_preferences: [{ instruction: 'synthetic preference', preference_key: 'p' }],
  task_guidance: { checkpoint: 'Checkpoint before finishing.' } });

function entryContext(output) {
  const text = output.hookSpecificOutput.additionalContext;
  return JSON.parse(text.slice(text.indexOf('\n{') + 1));
}

for (const [name, run, compaction] of [
  ['Claude', claudeLifecycleOutput, '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}'],
  ['Codex', codexLifecycleOutput, '{"timestamp":"2026-10-14T00:00:00Z","type":"compacted","payload":{"message":""}}']
]) {
  test(`${name} entries reference unchanged context within a host session until it compacts`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), `fuli-${name.toLowerCase()}-session-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
    const input = { session_id: `synthetic-${name}`, cwd: root, prompt: 'Synthetic prompt.', transcript_path: transcript };
    const enter = async () => entryContext(await run('UserPromptSubmit', input, async () => context(),
      { guidanceDirectory: join(root, 'guidance') }));

    assert.equal((await enter()).effective_preferences.length, 1);
    appendFileSync(transcript, '{"type":"assistant"}\n');
    assert.equal((await enter()).effective_preferences, undefined);
    appendFileSync(transcript, `${compaction}\n`);
    assert.equal((await enter()).effective_preferences.length, 1);
  });
}

test('each adapter recognizes only its own host compaction record', () => {
  assert.equal(CLAUDE_COMPACTION_PATTERN.test('{"type":"system","subtype": "compact_boundary"}'), true);
  assert.equal(CLAUDE_COMPACTION_PATTERN.test('{"type":"compacted"}'), false);
  assert.equal(CODEX_COMPACTION_PATTERN.test('{"type": "compacted","payload":{}}'), true);
  assert.equal(CODEX_COMPACTION_PATTERN.test('{"subtype":"compact_boundary"}'), false);
});
