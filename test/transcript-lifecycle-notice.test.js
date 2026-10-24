import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { transcriptLifecycle } from '../src/conversations/transcript-lifecycle.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { beginConversation } from '../src/graphiti/agent-conversations.js';

// rec#11 D-53: a begin cut short is deferred only when a later write really
// continues it. The transcript guard records the entry once this session's
// native stream is initialized; the claim or the next hook then hands the
// transcript to the entered task, whose import writes its conversation. A
// fresh session has no such guard yet, so its entry stays unsaved.
test('a task entry cut short is deferred only when the transcript guard records it for the next hook', async t => {
  for (const [initialized, expected] of [[true, 'deferred'], [false, 'unsaved']]) {
    const root = await mkdtemp(join(tmpdir(), 'fuli-transcript-deferred-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const transcript = join(root, 'session.jsonl');
    const native = `${JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session' } })}\n`;
    await writeFile(transcript, native);
    const end = Buffer.byteLength(native);
    const current = { token: 'fuli-task-synthetic', project_agent_id: 'engineer', personal_project_id: 'synthetic-project',
      session_id: 'synthetic-session', source_application: 'codex', personal_space_id: 'space' };
    const application = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
      getCapturePolicyVersion: () => 'absent', personal: {
        currentTaskContext: async () => current,
        conversation: async (operation, query) => {
          if (operation === 'begin') return new Promise(() => {});
          if (query.mode === 'policy') return { enabled: true };
          if (query.mode === 'session') return { initialized, cursor: initialized ? end : 0 };
          return { status: 'saved', cursor: end };
        } } };
    let conversation;
    await transcriptLifecycle({ application, runtimeConfigPath: join(root, 'runtime.json'), event: 'UserPromptSubmit',
      sourceApplication: 'codex', captureTimeoutMs: 50,
      input: { session_id: 'synthetic-session', cwd: root, prompt: 'Synthetic task.', transcript_path: transcript },
      adapter: { normalize: normalizeCodexRecord, verify: verifyCodexTranscript },
      run: async onContext => {
        conversation = await beginConversation(application, { token: current.token, sessionId: 'synthetic-session',
          personalProjectId: 'synthetic-project', projectAgentId: 'engineer', sourceApplication: 'codex' });
        onContext({ taskContextToken: current.token });
        return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Synthetic context.' } };
      } });
    assert.deepEqual([conversation.status, conversation.step, conversation.reason],
      [expected, 'begin', 'transcript_capture_timeout'], `initialized: ${initialized}`);
  }
});

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
