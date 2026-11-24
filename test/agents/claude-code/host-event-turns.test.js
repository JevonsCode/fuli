// Synthetic sessions, transcripts and preferences only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-event.js';
import { copyPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
import { claudeEntrySession, claudeHostEventSession, hookFrame, syntheticLargeEntry, syntheticPreferences }
  from '../../../test-support/synthetic-large-entry.js';

const bodies = text => text.match(/SYNTHETIC_[A-Z]+_\d+: [^"]{20}/g) ?? [];

test('host event turns of a session are silent and no preference body is sent twice', async () => {
  const frames = await claudeHostEventSession();
  assert.deepEqual(frames.map(frame => frame.origin), ['person', ...Array(10).fill('host_event'), 'person']);
  for (const { origin, text } of frames.filter(frame => frame.origin === 'host_event')) {
    assert.equal(text, '', origin);
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

test('notifications after compaction stay silent until the next human entry', () =>
  claudeEntrySession(async session => {
    const f = hostEventFixture(session);
    await session.turn(f.entry('task-1'));
    await session.host.say('assistant', 'SYNTHETIC reply.');
    // Claude Code clears the record at PreCompact and writes its boundary.
    await claudeLifecycleOutput('PreCompact', { session_id: session.sessionId, transcript_path: session.host.path }, f.read,
      { delivery: session.delivery });
    await session.host.compact();
    const first = await session.notify(f.task, f.read);
    assert.equal(first, '');
    assert.equal(await session.notify(f.task, f.read), '');
    assert.deepEqual(f.reads, []);
    const next = await session.turn(f.entry('task-2'));
    assert.equal(next.frame.effective_preferences.length, 20);
  }));

test('a frame the transcript never records was lost: notifications stay silent and the next prompt gets it whole', () =>
  claudeEntrySession(async session => {
    const f = hostEventFixture(session);
    // Delivered, but the host never records it before the model answers.
    const lost = (await claudeLifecycleOutput('UserPromptSubmit', { session_id: session.sessionId, transcript_path: session.host.path,
      cwd: '/synthetic/project', prompt: 'fix the export bug' }, async () => f.entry('task-1'), { delivery: session.delivery }))
      .hookSpecificOutput.additionalContext;
    assert.equal(hookFrame(lost).effective_preferences.length, 20);
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const event = await session.notify(f.task, f.read);
    assert.equal(event, '');
    await session.host.say('assistant', 'SYNTHETIC reply.');
    assert.equal(await session.notify(f.task, f.read), '');
    assert.deepEqual(f.reads, []);
    const fresh = await session.turn(f.entry('task-2'));
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

// #1087 x #1071: the person's message after a host event is a repeat candidate
// ("I already told you"). Its guidance is delivered as usual, the habits are a
// delta on the first frame, and the candidate changes nothing about the checkpoint.
test('a repeat candidate after a host event: its guidance rides a delta, and the checkpoint stays the entry\'s', async () => {
  const { beginTaskFromPreferences } = await import('../../../src/graphiti/agent-knowledge-workflows.js');
  const { taskRecord } = await import('../../../src/mcp/provider-task-context-registry.js');
  const { REPEAT_GUIDANCE } = await import('../../../src/graphiti/task-repeat-signal.js');
  const requested = [];
  const application = { config: { personal: { spaceId: 'space' } }, taskContextRegistry: {
    begin: async request => {
      requested.push(request.checkpointRequest);
      return taskRecord({ token: 'fuli-task-synthetic-cross', session_id: 's', personal_project_id: null,
        routine_auto_close_eligible: true, entry_via: 'hook' });
    } } };
  const preferences = { context: { personal_project_id: null, project_agent_id: null }, effective_preferences: [] };
  const enter = taskPrompt => beginTaskFromPreferences(application, preferences, { sessionId: 's', taskPrompt }, { entryVia: 'hook' });
  const plain = await enter('fix the export bug');
  const repeating = await enter('我已经说过了，提交信息用英文。');
  assert.equal(repeating.remember_guidance, REPEAT_GUIDANCE);
  assert.deepEqual(requested, [null, null], 'a candidate is no checkpoint request');
  const decision = ({ checkpoint_required, checkpoint_reason }) => ({ checkpoint_required, checkpoint_reason });
  assert.deepEqual(decision(repeating), decision(plain));
  assert.equal(repeating.checkpoint_required, false);

  await claudeEntrySession(async session => {
    const f = hostEventFixture(session);
    const first = await session.turn(f.entry('task-1'));
    await session.host.say('assistant', 'SYNTHETIC reply.');
    assert.equal(await session.notify(f.task, f.read), '');
    await session.host.say('assistant', 'SYNTHETIC reply.');
    const value = f.entry('task-2');
    const { text, frame } = await session.turn(copyPreferenceScope(value, { ...value, ...decision(repeating),
      remember_guidance: repeating.remember_guidance }));
    assert.equal(frame.remember_guidance, REPEAT_GUIDANCE);
    assert.equal(frame.preference_delivery.status, 'delta');
    assert.equal(frame.preference_delivery.base_revision, first.frame.revision);
    assert.deepEqual([frame.preference_updates, frame.preference_delivery.removed], [[], []]);
    assert.deepEqual(bodies(text), [], 'no habit is sent again');
    assert.equal(frame.checkpoint_required, false);
  });
});
