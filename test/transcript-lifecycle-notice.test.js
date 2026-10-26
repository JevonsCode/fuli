import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { transcriptLifecycle } from '../src/conversations/transcript-lifecycle.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { beginConversation } from '../src/graphiti/agent-conversations.js';
import { runWithAgentRequestContext } from '../src/app/agent-request-context.js';

// rec#11 D-53: a begin cut short is deferred only when a later write really
// continues it. The transcript guard records the entry once this session's
// native stream is initialized; the claim or the next hook then hands the
// transcript to the entered task, whose import writes its conversation.
//
// No outcome here depends on how fast the machine is. The begin is cut short
// by the event that cuts a capture window, an abort that its own (never
// answered) request raises; the steps before it either run under a budget
// they cannot reach or wait on a read that is never answered.
async function entryWithCutBegin(t, { initialized = true, sessionRead = 'answered', captureTimeoutMs = 30_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-transcript-deferred-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const transcript = join(root, 'session.jsonl');
  const native = `${JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session' } })}\n`;
  await writeFile(transcript, native);
  const end = Buffer.byteLength(native);
  const current = { token: 'fuli-task-synthetic', project_agent_id: 'engineer', personal_project_id: 'synthetic-project',
    session_id: 'synthetic-session', source_application: 'codex', personal_space_id: 'space' };
  const cut = new AbortController();
  // What the transcript guard held when the begin was sent: the entry recorded ('beginning') or nothing.
  const guardAtBegin = async () => {
    const guards = join(root, 'transcript-guards');
    const files = await readdir(guards).catch(() => []);
    return files.length ? JSON.parse(await readFile(join(guards, files[0]), 'utf8')).phase : null;
  };
  let guard;
  const application = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
    getCapturePolicyVersion: () => 'absent', personal: {
      currentTaskContext: async () => current,
      conversation: async (operation, query) => {
        if (operation === 'begin') {
          guard = await guardAtBegin();
          cut.abort();
          return new Promise(() => {});
        }
        if (query.mode === 'policy') return { enabled: true };
        if (query.mode === 'session') {
          return sessionRead === 'hangs' ? new Promise(() => {}) : { initialized, cursor: initialized ? end : 0 };
        }
        return { status: 'saved', cursor: end };
      } } };
  let conversation;
  await transcriptLifecycle({ application, runtimeConfigPath: join(root, 'runtime.json'), event: 'UserPromptSubmit',
    sourceApplication: 'codex', captureTimeoutMs,
    input: { session_id: 'synthetic-session', cwd: root, prompt: 'Synthetic task.', transcript_path: transcript },
    adapter: { normalize: normalizeCodexRecord, verify: verifyCodexTranscript },
    run: async onContext => {
      conversation = await runWithAgentRequestContext({ signal: cut.signal }, () => beginConversation(application, {
        token: current.token, sessionId: 'synthetic-session', personalProjectId: 'synthetic-project',
        projectAgentId: 'engineer', sourceApplication: 'codex' }));
      onContext({ taskContextToken: current.token });
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Synthetic context.' } };
    } });
  return { conversation: [conversation.status, conversation.step, conversation.reason], guard };
}

test('a begin cut short after the transcript guard recorded the entry is deferred to the next hook', async t => {
  assert.deepEqual(await entryWithCutBegin(t),
    { conversation: ['deferred', 'begin', 'transcript_capture_timeout'], guard: 'beginning' });
});

test('a fresh session has no guard recording its entry yet, so a begin cut short stays unsaved', async t => {
  assert.deepEqual(await entryWithCutBegin(t, { initialized: false }),
    { conversation: ['unsaved', 'begin', 'transcript_capture_timeout'], guard: null });
});

// The import before the entry may use up its own budget first: the entry then
// runs on the blocked path, which records nothing for the next hook to finish.
test('when the steps before the entry exhaust their budget, a begin cut short stays unsaved', async t => {
  assert.deepEqual(await entryWithCutBegin(t, { sessionRead: 'hangs', captureTimeoutMs: 20 }),
    { conversation: ['unsaved', 'begin', 'transcript_capture_timeout'], guard: null });
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
