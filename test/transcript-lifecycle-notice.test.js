import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { transcriptLifecycle } from '../src/conversations/transcript-lifecycle.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';

test('a transcript import that runs out of time says it was deferred, not that history is unverified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-transcript-notice-'));
  try {
    const transcript = join(root, 'session.jsonl');
    await writeFile(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session' } })}\n`);
    const hang = () => new Promise(() => {});
    const application = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
      personal: { currentTaskContext: hang, conversation: hang } };
    const output = await transcriptLifecycle({ application, runtimeConfigPath: join(root, 'runtime.json'), event: 'UserPromptSubmit',
      sourceApplication: 'codex', captureTimeoutMs: 20,
      input: { session_id: 'synthetic-session', cwd: root, prompt: 'Synthetic task.', transcript_path: transcript },
      adapter: { normalize: normalizeCodexRecord, verify: verifyCodexTranscript },
      run: async () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Synthetic context.' } }) });
    assert.equal(output.hookSpecificOutput.additionalContext, 'Synthetic context.');
    assert.match(output.systemMessage, /deferred/);
    assert.doesNotMatch(output.systemMessage, /Unverified/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
