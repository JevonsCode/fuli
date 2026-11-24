import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexLifecycleOutput, runCodexLifecycleCommand, runCodexLifecycleHook } from '../src/agents/codex/lifecycle-event.js';
import { transcriptCaptureLedger } from '../src/conversations/transcript-capture-gap.js';
import { transcriptDigest } from '../src/conversations/transcript-guard.js';

// rec#28. In the source at openai/codex deede7201da2 (codex-rs/hooks/src/schema.rs
// 566-584) Codex's hook input has no isMeta or is_meta, so a turn marked that
// way has an unprovable source: it contributes no task context, is
// held as unresolved, and never enters, switches or settles a task.
// Synthetic sessions, Provider doubles and transcripts only.

const input = { session_id: 'synthetic-codex-session', turn_id: 'synthetic-turn', cwd: '/synthetic/project',
  prompt: 'Synthetic hook verification.', transcript_path: null, model: 'synthetic-model', permission_mode: 'default' };
function submitFixture() {
  const calls = [];
  const invoke = async name => {
    calls.push(name);
    assert.equal(name, 'begin_task_context');
    return { taskContextToken: 'fuli-task-new-entry' };
  };
  return { calls, submit: extra => codexLifecycleOutput('UserPromptSubmit', { ...input, ...extra }, invoke) };
}

test('Codex isMeta and is_meta turns stay quiet; every other prompt enters', async () => {
  for (const mark of [{ isMeta: true }, { is_meta: true }]) {
    const f = submitFixture();
    const output = await f.submit({ prompt: 'Any text marked as a system delivery.', ...mark });
    assert.deepEqual(output, {}, JSON.stringify(mark));
    assert.deepEqual(f.calls, []);
  }
  // Codex has no notification envelopes: shaped text, or a mark that is not exactly true, enters as a prompt.
  for (const extra of [{ prompt: '<task-notification>\n<task-id>bsynth01x</task-id>\n</task-notification>' },
    { prompt: '<teammate-message>quoted by the user</teammate-message>' }, { isMeta: 'true' }, { isMeta: false }, { is_meta: 1 }]) {
    const f = submitFixture();
    const output = await f.submit(extra);
    assert.deepEqual(f.calls, ['begin_task_context'], JSON.stringify(extra));
    assert.match(output.hookSpecificOutput.additionalContext, /fuli-task-new-entry/);
  }
});

test('Codex installed hook: a session FULI is off for gets no refresh, and the turn is still held', async t => {
  const s = await codexSession(t);
  s.app.getSessionCapturePause = () => ({ stopped: true, paused: false, fuli: { enabled: false, basis: 'person', since: 'synthetic' } });
  s.app.hasStoppedSession = () => true;
  s.app.pinSessionFuliDefault = () => {};
  const output = await s.hook('UserPromptSubmit', { prompt: 'Marked delivery.', isMeta: true });
  assert.deepEqual(output, {});
  assert.doesNotMatch(JSON.stringify(output), /fuli-task-synthetic-a|current task context/);
  assert.deepEqual(s.calls, [], 'no Provider read');
  assert.deepEqual(s.lookups, [], 'no current task lookup');
  assert.equal(s.ledger.heldTurns().turns.length, 1, 'held before the session check, like any unprovable turn');
});

// A synthetic Codex session through the installed hook: a fake Provider keeps
// the transcript cursor and what each append attributed to which task. Codex
// runs UserPromptSubmit before it records the prompt in its rollout.
async function codexSession(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-codex-unresolved-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const transcript = join(directory, 'rollout.jsonl');
  const record = value => JSON.stringify(value) + '\n';
  const message = (role, text) => record({ type: 'response_item', payload: { type: 'message', role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  await writeFile(transcript, record({ type: 'session_meta', payload: { id: input.session_id } }) + message('user', 'Synthetic task A.'));
  const task = { token: 'fuli-task-synthetic-a', project_agent_id: 'engineer', personal_project_id: 'synthetic-project',
    session_id: input.session_id, source_application: 'codex', personal_space_id: 'synthetic-space', entry_via: 'hook' };
  const state = { current: task, checkpointed: [], cursor: 0, appended: [], revision: 1 };
  const calls = [], lookups = [];
  const app = { config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }),
    getCapturePolicyVersion: () => 'absent',
    taskContextRegistry: { current: async () => {
      lookups.push('current');
      return state.current && { token: state.current.token, sessionId: input.session_id, sourceApplication: 'codex',
        checkpoint: state.checkpointed.includes(state.current.token) ? { phase: 'complete' } : null };
    } },
    personal: {
      currentTaskContext: async () => state.current,
      conversation: async (operation, query) => {
        if (query.mode === 'policy') return { enabled: true };
        if (query.mode === 'session') return { initialized: true, cursor: state.cursor };
        if (operation === 'append') {
          assert.equal(query.expected_cursor, state.cursor);
          state.appended.push(...query.events.map(event => ({ token: query.task_context_token, ...event })));
          state.cursor = query.cursor;
          return { status: 'saved' };
        }
        if (operation === 'boundary' && Number.isSafeInteger(query.cursor)) state.cursor = query.cursor;
        return { status: 'saved', cursor: state.cursor };
      }
    } };
  const { prompt: _prompt, ...native } = { ...input, transcript_path: transcript };
  const hook = (event, extra = {}) => runCodexLifecycleHook(['--event', event], {
    readInput: async () => ({ ...native, ...extra }), write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, run) => run() }), captureTimeoutMs: 30_000,
    callTool: async (_app, name, parameters) => {
      calls.push([name, parameters.taskContextToken ?? null]);
      if (name === 'read_task_preferences') return { taskContextToken: parameters.taskContextToken,
        checkpoint_required: state.revision > 1, effective_preferences: [{ instruction: `Synthetic preference, revision ${state.revision}.` }] };
      if (name === 'begin_task_context') {
        state.current = { ...task, token: 'fuli-task-synthetic-b' };
        return { taskContextToken: state.current.token, effective_preferences: [] };
      }
      if (name === 'verify_task_checkpoint') return state.checkpointed.includes(state.current.token) ? { status: 'checkpointed' }
        : { decision: 'block', entry_via: 'hook', task_context_token: state.current.token, reason: 'FULI_CHECKPOINT_REQUIRED: synthetic' };
      if (name === 'checkpoint_task_knowledge') state.checkpointed.push(parameters.taskContextToken);
      return { status: 'saved' };
    } });
  const ledger = transcriptCaptureLedger(runtimeConfigPath, input, 'codex');
  const host = (role, text) => appendFile(transcript, message(role, text));
  return { app, state, calls, lookups, hook, ledger, task, host, runtimeConfigPath,
    // A turn marked isMeta: the hook runs, then Codex records the prompt and the reply.
    async markedTurn(reply = 'SYNTHETIC_UNKNOWN_TURN_REPLY') {
      const output = await hook('UserPromptSubmit', { prompt: 'SYNTHETIC_MARKED_PROMPT', isMeta: true });
      await host('user', 'SYNTHETIC_MARKED_PROMPT');
      await host('assistant', reply);
      return output;
    },
    // A Stop that settles nothing: no verify, no automatic checkpoint.
    async quietStop(label) {
      calls.length = 0;
      const output = await hook('Stop');
      assert.match(output.systemMessage ?? '', /^(Fuli: 这段内容的任务归属未确认，未记入任何任务；原文仍在本地会话记录中)?$/, label);
      assert.deepEqual(calls, [], `${label}: the held task is neither verified nor settled`);
      assert.ok(ledger.heldTurns().turns.length || ledger.heldTurns().unprovable, `${label}: the turn stays held`);
    },
    said: () => state.appended.filter(event => !/^\[Not recorded/.test(event.content)) };
}

test('Codex installed hook holds a marked turn, stays silent and claims no transcript boundary', async t => {
  const s = await codexSession(t);
  const output = await s.markedTurn();
  assert.deepEqual(s.calls, []);
  assert.deepEqual(output, {});
  const [held] = s.ledger.heldTurns().turns;
  assert.equal(held.owner, transcriptDigest('fuli-task-synthetic-a'), 'the turn names the task it was current for');
  assert.equal(s.state.cursor, 0, 'the notification imports nothing');
});

test('Codex unresolved turns never settle A or record under it; A can still checkpoint; B gets its own token', async t => {
  const s = await codexSession(t);
  await s.markedTurn();
  await s.quietStop('marked turn');
  await s.quietStop('marked turn, repeated Stop');
  // A preference change is left for the next human entry.
  s.state.revision = 2;
  assert.deepEqual(await s.markedTurn('SYNTHETIC_SECOND_REPLY'), {});
  await s.quietStop('second marked turn');
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY|SYNTHETIC_SECOND_REPLY|SYNTHETIC_MARKED_PROMPT/);
  assert.ok(s.state.appended.some(event => /task ownership was not confirmed/.test(event.content)), 'skipped with a reason');
  // Unfinished A was never replaced and can still be checkpointed explicitly by the model.
  assert.equal(s.state.current.token, 'fuli-task-synthetic-a');
  assert.ok(s.calls.every(([name]) => name !== 'begin_task_context'));
  s.state.checkpointed.push('fuli-task-synthetic-a');
  // No Codex turn is proven a continuation, so the held turn is not imported under A even then.
  await s.quietStop('A checkpointed, still unproven');
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY|SYNTHETIC_SECOND_REPLY/);
  // An explicit new task B enters normally with its own token and ends the held turns.
  const entered = await s.hook('UserPromptSubmit', { prompt: 'Synthetic task B.' });
  await s.host('user', 'Synthetic task B.');
  assert.match(entered.hookSpecificOutput.additionalContext, /fuli-task-synthetic-b/);
  assert.ok(entered.hookSpecificOutput.additionalContext);
  assert.deepEqual(s.ledger.heldTurns().turns, []);
  await s.host('assistant', 'SYNTHETIC_TASK_B_REPLY');
  s.calls.length = 0;
  await s.hook('Stop');
  assert.deepEqual(s.calls.map(([name, token]) => [name, token]), [['verify_task_checkpoint', null],
    ['checkpoint_task_knowledge', 'fuli-task-synthetic-b']]);
  assert.ok(s.said().some(event => event.token === 'fuli-task-synthetic-b' && /SYNTHETIC_TASK_B_REPLY/.test(event.content)));
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY|SYNTHETIC_SECOND_REPLY/);
});

test('Codex unresolved turns stay held through resume and compaction, which still refresh A', async t => {
  const s = await codexSession(t);
  await s.markedTurn();
  s.state.revision = 2;
  for (const source of ['resume', 'compact']) {
    s.calls.length = 0;
    const restored = await s.hook('SessionStart', { source });
    assert.deepEqual(s.calls, [['read_task_preferences', 'fuli-task-synthetic-a']], source);
    assert.match(restored.hookSpecificOutput.additionalContext, /restored current mandatory preferences for the same owned task/);
    assert.match(restored.hookSpecificOutput.additionalContext, /revision 2/);
    assert.ok(s.ledger.heldTurns().turns.length, source);
    await s.host('assistant', `SYNTHETIC_AFTER_${source.toUpperCase()}`);
    await s.quietStop(source);
  }
  for (const [label, event, extra] of [['startup', 'SessionStart', { source: 'startup' }],
    ['clear', 'SessionStart', { source: 'clear' }], ['compaction', 'PreCompact', { trigger: 'auto' }]]) {
    s.calls.length = 0;
    assert.deepEqual(await s.hook(event, extra), {}, label);
    assert.deepEqual(s.calls, [], label);
    await s.quietStop(label);
  }
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_UNKNOWN_TURN_REPLY|SYNTHETIC_AFTER_/);
});

test('Codex task entry without a transcript path keeps the held turn until its span is verified and skipped', async t => {
  // dot, #276: an empty path is no proof that the session has no history.
  const s = await codexSession(t);
  await s.markedTurn('SYNTHETIC_OLD_HELD_REPLY');
  const [old] = s.ledger.heldTurns().turns;
  const entered = await s.hook('UserPromptSubmit', { prompt: 'Synthetic task B.', transcript_path: null });
  assert.match(entered.hookSpecificOutput.additionalContext, /fuli-task-synthetic-b/);
  assert.deepEqual(s.ledger.heldTurns().turns.map(turn => turn.turn), [old.turn], 'not released by a pathless entry');
  await s.host('user', 'Synthetic task B.');
  await s.host('assistant', 'SYNTHETIC_TASK_B_REPLY');
  // A pathless Stop cannot verify the span either: still held, nothing settled.
  s.calls.length = 0;
  await s.hook('Stop', { transcript_path: null });
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.ledger.heldTurns().turns.map(turn => turn.turn), [old.turn]);
  // The path comes back: the held span is skipped first, then B is settled; the old turn never reaches B.
  await s.hook('Stop');
  assert.deepEqual(s.ledger.heldTurns().turns, []);
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_OLD_HELD_REPLY|SYNTHETIC_MARKED_PROMPT/);
  assert.ok(s.state.appended.some(event => /task ownership was not confirmed/.test(event.content)));
  assert.deepEqual(s.calls.map(([name, token]) => [name, token]), [['verify_task_checkpoint', null],
    ['checkpoint_task_knowledge', 'fuli-task-synthetic-b']]);
});

test('Codex unresolved turn ends without an owner when another task became current during it', async t => {
  const s = await codexSession(t);
  await s.markedTurn('SYNTHETIC_MOVED_REPLY');
  s.state.current = { ...s.task, token: 'fuli-task-synthetic-c' };
  s.calls.length = 0;
  await s.hook('Stop');
  assert.deepEqual(s.ledger.heldTurns().turns, []);
  assert.deepEqual(s.calls, [['verify_task_checkpoint', null], ['checkpoint_task_knowledge', 'fuli-task-synthetic-c']],
    'the new current task settles normally');
  assert.doesNotMatch(JSON.stringify(s.said()), /SYNTHETIC_MOVED_REPLY|SYNTHETIC_MARKED_PROMPT/);
});

test('Codex marked turn is held back when its unresolved state cannot be kept anywhere', async t => {
  const s = await codexSession(t);
  const key = transcriptDigest(`${s.runtimeConfigPath}\0codex\0${input.session_id}`);
  for (const directory of ['transcript-capture', 'transcript-turn-holds']) {
    await mkdir(join(s.runtimeConfigPath, '..', directory, `${key}.json`), { recursive: true });
  }
  const output = await s.hook('UserPromptSubmit', { prompt: 'Marked delivery.', isMeta: true });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /FULI 拦下了这条消息.*它带有无法证明来源的 isMeta 标记/);
  assert.match(output.reason, /it carries an isMeta mark whose source cannot be proven.*resend the message yourself/);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.lookups, []);
});

test('Codex marked turn with a session-less or unavailable runtime never asks the model to enter this turn as a task', async () => {
  let output = '';
  const result = await runCodexLifecycleCommand(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ ...input, isMeta: true }), write: value => { output += value; },
    resolveRuntimeOptions: () => ({ runtimeConfigPath: null }),
    openApplication: () => { throw new Error('synthetic runtime outage'); }
  });
  assert.equal(result.timedOut, false);
  const delivered = JSON.parse(output);
  assert.equal(delivered.decision, 'block', 'without a data directory the turn cannot be held, so it does not run unprotected');
  output = '';
  const directory = await mkdtemp(join(tmpdir(), 'fuli-codex-unavailable-'));
  try {
    await runCodexLifecycleCommand(['--event', 'UserPromptSubmit'], {
      readInput: async () => ({ ...input, isMeta: true }), write: value => { output += value; },
      resolveRuntimeOptions: () => ({ runtimeConfigPath: join(directory, 'runtime.json') }),
      openApplication: () => { throw new Error('synthetic runtime outage'); }
    });
    assert.deepEqual(JSON.parse(output), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});
