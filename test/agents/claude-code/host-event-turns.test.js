// Design T1: a session's context is given once. A host event turn (a
// background task's notification) is told so in one line instead of being
// given the current task again; only a context generation that has given the
// session nothing yet (after a compaction, a lost frame) gets it whole.
// Synthetic sessions, transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-event.js';
import { copyPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
import { claudeEntrySession, claudeHostEventSession, hookFrame, syntheticLargeEntry, syntheticPreferences }
  from '../../../test-support/synthetic-large-entry.js';

const HOST_LINE = 'FULI：本轮是宿主事件，非人发消息；当前任务和已下发的上下文仍有效，不必再取。 '
  + 'FULI: a host event, not a person\'s message; the current task and given context still apply: no get_collaboration_preferences call.';
const bodies = text => text.match(/SYNTHETIC_[A-Z]+_\d+: [^"]{20}/g) ?? [];

test('host event turns of a session are one line each and no preference body is sent twice', async () => {
  const frames = await claudeHostEventSession();
  assert.deepEqual(frames.map(frame => frame.origin), ['person', ...Array(5).fill('host_event'), 'person']);
  for (const { origin, text } of frames.filter(frame => frame.origin === 'host_event')) {
    assert.equal(text, HOST_LINE, origin);
    assert.ok(text.length <= 200 && !text.includes('\n'));
  }
  const sent = frames.flatMap(frame => bodies(frame.text));
  assert.ok(sent.length > 0);
  assert.deepEqual(sent.filter((body, index) => sent.indexOf(body) !== index), [], 'every body is sent once');
  // The person's next turn keeps every preference the first one spelled out,
  // so it is a delta although its recall and guidance differ; its lighter
  // recall leaves room for bodies the first could only name, each sent once
  // (design T3).
  const first = hookFrame(frames[0].text);
  const next = hookFrame(frames.at(-1).text);
  assert.equal(next.preference_delivery.status, 'delta');
  assert.equal(next.preference_delivery.base_revision, first.revision);
  assert.deepEqual(next.preference_delivery.removed, []);
  assert.equal(next.preference_delivery.unchanged, first.effective_preferences.length);
  assert.ok(next.preference_updates.length > 0);
  // The checkpoint decision is the entry's alone: no host event turn restates it.
  assert.ok(frames.filter(frame => frame.origin === 'host_event').every(frame => !frame.text.includes('checkpoint_required')));
});

// One session with its current task and the reader's result for it.
function hostEventFixture(session) {
  const items = syntheticPreferences(20, { length: 130 });
  const entry = token => syntheticLargeEntry({ items, sessionId: session.sessionId, token });
  const task = { token: 'task-1', sessionId: session.sessionId, sourceApplication: 'claude_code', checkpoint: null };
  const reads = [];
  const read = async (name, parameters) => {
    reads.push(name);
    return copyPreferenceScope(entry(parameters.taskContextToken), { ...entry(parameters.taskContextToken),
      preference_delivery: { status: 'complete' }, preferences_complete: true, same_task_recovery_available: true, truncated: false });
  };
  return { entry, task, read, reads };
}

test('the first host event after a compaction gets the whole context, and the one after it one line', () =>
  claudeEntrySession(async session => {
    const f = hostEventFixture(session);
    await session.turn(f.entry('task-1'));
    await session.host.say('assistant', 'SYNTHETIC reply.');
    // Claude Code clears the record at PreCompact and writes its boundary.
    await claudeLifecycleOutput('PreCompact', { session_id: session.sessionId, transcript_path: session.host.path }, f.read,
      { delivery: session.delivery });
    await session.host.compact();
    const first = await session.notify(f.task, f.read);
    assert.deepEqual(f.reads, ['read_task_preferences']);
    assert.equal(hookFrame(first).taskContextToken, 'task-1');
    assert.equal(hookFrame(first).effective_preferences.length, 20);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    assert.equal(await session.notify(f.task, f.read), HOST_LINE);
    assert.equal(f.reads.length, 1);
  }));

test('a frame the transcript never records was lost: the next host event and the next prompt get it whole', () =>
  claudeEntrySession(async session => {
    const f = hostEventFixture(session);
    // Delivered, but the host never records it before the model answers.
    const lost = (await claudeLifecycleOutput('UserPromptSubmit', { session_id: session.sessionId, transcript_path: session.host.path,
      cwd: '/synthetic/project', prompt: 'fix the export bug' }, async () => f.entry('task-1'), { delivery: session.delivery }))
      .hookSpecificOutput.additionalContext;
    assert.equal(hookFrame(lost).effective_preferences.length, 20);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const event = await session.notify(f.task, f.read);
    assert.equal(hookFrame(event).effective_preferences.length, 20);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    // That one was recorded, so the next host event is one line.
    assert.equal(await session.notify(f.task, f.read), HOST_LINE);
    // A prompt whose base was lost is whole again too.
    const fresh = await claudeEntrySession(async other => {
      const g = hostEventFixture(other);
      await claudeLifecycleOutput('UserPromptSubmit', { session_id: other.sessionId, transcript_path: other.host.path,
        cwd: '/synthetic/project', prompt: 'fix the export bug' }, async () => g.entry('task-1'), { delivery: other.delivery });
      await other.host.say('assistant', 'SYNTHETIC reply.');
      return other.turn(g.entry('task-2'));
    });
    assert.equal(fresh.frame.preference_delivery, undefined);
    assert.equal(fresh.frame.effective_preferences.length, 20);
  }));

test('a prompt whose hook runs before the previous frame is recorded is an empty delta on it', () =>
  claudeEntrySession(async session => {
    const f = hostEventFixture(session);
    const input = { session_id: session.sessionId, transcript_path: session.host.path, cwd: '/synthetic/project', prompt: 'next' };
    const hook = async token => (await claudeLifecycleOutput('UserPromptSubmit', input, async () => f.entry(token),
      { delivery: session.delivery })).hookSpecificOutput.additionalContext;
    const first = await hook('task-1');
    const second = await hook('task-2');
    const frame = hookFrame(second);
    assert.equal(frame.preference_delivery.status, 'delta');
    assert.equal(frame.preference_delivery.base_revision, hookFrame(first).revision);
    assert.deepEqual(frame.preference_updates, []);
    // Both recorded in order, the next prompt builds on the second.
    await session.host.inject(first);
    await session.host.inject(second);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const third = await session.turn(f.entry('task-3'));
    assert.equal(third.frame.preference_delivery.base_revision, frame.preference_delivery.revision);
  }));

// Review of #1087: a frame is lost and, before the model answers, another
// prompt's hook runs. That one is built on the lost frame (an empty delta),
// so two turns in a row lack the context. The third turn cannot verify that
// base in the transcript and gets the whole context again.
test('a lost frame followed by a prompt before any answer: the third turn is whole', () =>
  claudeEntrySession(async session => {
    const f = hostEventFixture(session);
    const input = { session_id: session.sessionId, transcript_path: session.host.path, cwd: '/synthetic/project', prompt: 'next' };
    const hook = async token => (await claudeLifecycleOutput('UserPromptSubmit', input, async () => f.entry(token),
      { delivery: session.delivery })).hookSpecificOutput.additionalContext;
    const lost = hookFrame(await hook('task-1'));
    const second = await hook('task-2');
    assert.equal(hookFrame(second).preference_delivery.base_revision, lost.revision, 'the window: built on the lost frame');
    await session.host.inject(second);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const third = await session.turn(f.entry('task-3'));
    assert.equal(third.frame.preference_delivery, undefined);
    assert.equal(third.frame.effective_preferences.length, 20);
  }));
