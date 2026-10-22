import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexLifecycleOutput, runCodexLifecycleCommand, runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { transcriptCaptureLedger } from '../src/conversations/transcript-capture-gap.js';
import { transcriptDigest } from '../src/conversations/transcript-guard.js';

// rec#28. In the source at openai/codex deede7201da2 (codex-rs/hooks/src/schema.rs
// 566-584) Codex's hook input has no isMeta or is_meta, so a turn marked that
// way has an unprovable source: it refreshes the current task in place, is
// held as unresolved, and never enters, switches or settles a task.
// Synthetic sessions, Provider doubles and transcripts only.

const input = { session_id: 'synthetic-codex-session', turn_id: 'synthetic-turn', cwd: '/synthetic/project',
  prompt: 'Synthetic hook verification.', transcript_path: null, model: 'synthetic-model', permission_mode: 'default' };
const UNCONFIRMED = /本轮输入带有 isMeta 标记.*FULI: this turn carries an isMeta mark, but FULI cannot prove the Codex host set it/;
// Codex has no continuation evidence, so its guidance must say a checkpoint does not resolve the turn (dot, #276).
const CODEX_RESOLUTION = /在 Codex 中，用这个 token 调用 checkpoint_task_knowledge 不会解除本轮的未确认状态.*In Codex, a checkpoint_task_knowledge with that token does not resolve this turn: the turn stays unconfirmed and is not recorded under that task\. The turn is resolved only when another task becomes current/;
const CLAUDE_RESOLUTION = 'This turn becomes that task\'s only by a successful checkpoint_task_knowledge';

// A synthetic Codex session whose current task the fake reader re-reads in place.
function refreshFixture({ task = { token: 'fuli-task-a', sessionId: input.session_id, sourceApplication: 'codex', checkpoint: null },
  read } = {}) {
  const calls = [];
  let revision = 1;
  const invoke = async (name, parameters) => {
    calls.push([name, parameters]);
    if (name === 'begin_task_context') return { taskContextToken: 'fuli-task-new-entry' };
    assert.equal(name, 'read_task_preferences');
    if (read) return read(parameters);
    return { taskContextToken: parameters.taskContextToken, checkpoint_required: revision > 1,
      effective_preferences: [{ instruction: `Synthetic preference, revision ${revision}.` }],
      active_conflicts: revision > 1 ? [{ id: 'synthetic-conflict' }] : [] };
  };
  const submit = (extra = {}, options = {}) => codexLifecycleOutput('UserPromptSubmit', { ...input, ...extra }, invoke,
    { currentTask: async (sessionId, source) => { calls.push(['current', sessionId, source]); return task; }, ...options });
  return { calls, invoke, submit, change: () => { revision = 2; } };
}

test('Codex isMeta and is_meta turns refresh the current task in place; every other prompt enters', async () => {
  for (const mark of [{ isMeta: true }, { is_meta: true }]) {
    const f = refreshFixture();
    const output = await f.submit({ prompt: 'Any text marked as a system delivery.', ...mark });
    assert.deepEqual(f.calls.map(([name]) => name), ['current', 'read_task_preferences'], JSON.stringify(mark));
    assert.deepEqual(f.calls[0].slice(1), [input.session_id, 'codex']);
    assert.deepEqual(f.calls[1][1], { taskContextToken: 'fuli-task-a', sourceApplication: 'codex',
      sourceSessionId: input.session_id, sourceSessionVerified: true });
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, UNCONFIRMED);
    assert.match(context, /no task was created or switched/);
    assert.match(context, /is not this turn's confirmed task/);
    assert.match(context, CODEX_RESOLUTION);
    assert.ok(!context.includes(CLAUDE_RESOLUTION), 'Codex never promises a resolution its Stop does not perform');
    assert.match(context, /start a task explicitly with get_collaboration_preferences/);
    assert.match(context, /"taskContextToken":"fuli-task-a"/);
    // The old trusted shortcut is gone: no "keep the current task" without a read.
    assert.doesNotMatch(context, /not a new user task|Keep the current task context|fuli-task-new-entry|Pass taskContextToken to every FULI call/);
  }
  // Codex has no notification envelopes: shaped text, or a mark that is not exactly true, enters as a prompt.
  for (const extra of [{ prompt: '<task-notification>\n<task-id>bsynth01x</task-id>\n</task-notification>' },
    { prompt: '<teammate-message>quoted by the user</teammate-message>' }, { isMeta: 'true' }, { isMeta: false }, { is_meta: 1 }]) {
    const f = refreshFixture();
    const output = await f.submit(extra);
    assert.deepEqual(f.calls.map(([name]) => name), ['begin_task_context'], JSON.stringify(extra));
    assert.match(output.hookSpecificOutput.additionalContext, /fuli-task-new-entry/);
  }
});

test('Codex refresh turns deliver a mid-run preference, conflict or checkpoint change on the next turn', async () => {
  const f = refreshFixture();
  for (let index = 0; index < 6; index += 1) {
    if (index === 3) f.change();
    const context = (await f.submit({ isMeta: true })).hookSpecificOutput.additionalContext;
    assert.match(context, new RegExp(`revision ${index < 3 ? 1 : 2}`));
    if (index >= 3) {
      assert.match(context, /synthetic-conflict/);
      assert.match(context, /"checkpoint_required":true/);
    } else assert.doesNotMatch(context, /synthetic-conflict/);
  }
  assert.ok(f.calls.every(([name]) => name !== 'begin_task_context'));
});

test('Codex refresh turns with nothing valid to re-read say so and start no task', async () => {
  const owned = { token: 'fuli-task-a', sessionId: input.session_id, sourceApplication: 'codex', checkpoint: null };
  const cases = [
    ['no current task', { task: null }, /本会话没有当前任务.*\(this session has no current task\)/],
    ['closed task', { task: { ...owned, checkpoint: { phase: 'complete' } } }, /\(the current task of this session is closed\)/],
    ['another session', { task: { ...owned, sessionId: 'another-session' } }, /\(the current task belongs to another session\)/],
    ['another Agent', { task: { ...owned, sourceApplication: 'claude_code' } }, /\(the current task belongs to another session\)/],
    ['missing Agent or scope', { task: owned, read: () => { throw Object.assign(new Error('Recovery requires the task Agent identity.'),
      { code: 'preference_recovery_blocked' }); } }, /\(the current task's ownership or scope could not be confirmed: Recovery requires the task Agent identity\.\)/],
    ['unknown token', { task: owned, read: () => { throw Object.assign(new Error('private Provider detail'), { code: 'not_found' }); } },
      /\(the current task's ownership or scope could not be confirmed\); no task/],
    ['FULI stopped since the task began', { task: owned, read: () => ({ status: 'fuli_off' }) }, /\(FULI is off for this session\)/]
  ];
  for (const [label, options, expected] of cases) {
    const f = refreshFixture(options);
    const context = (await f.submit({ isMeta: true })).hookSpecificOutput.additionalContext;
    assert.match(context, expected, label);
    assert.match(context, /FULI：本轮没有建立有效的任务上下文.*FULI: no valid task context is established for this turn/, label);
    assert.doesNotMatch(context, /fuli-task-a|private Provider detail/, label);
    assert.ok(f.calls.every(([name]) => name !== 'begin_task_context'), label);
  }
});

test('Codex session off is checked before a refresh: nothing is read or injected', async () => {
  const f = refreshFixture();
  const off = await f.submit({ isMeta: true }, { entryRefusal: async () => ({ allowed: false, reason: 'session_stopped' }) });
  assert.deepEqual(f.calls, [], 'no current task lookup and no preference read');
  const context = off.hookSpecificOutput.additionalContext;
  assert.match(context, /FULI is stopped for this session by the person\. No FULI memory, preferences or task token this turn/);
  assert.doesNotMatch(context, /fuli-task-a|current task context|taskContextToken/);
});

test('Codex installed hook: a session FULI is off for gets no refresh, and the turn is still held', async t => {
  const s = await codexSession(t);
  s.app.getSessionCapturePause = () => ({ stopped: true, paused: false, fuli: { enabled: false, basis: 'person', since: 'synthetic' } });
  s.app.hasStoppedSession = () => true;
  s.app.pinSessionFuliDefault = () => {};
  const output = await s.hook('UserPromptSubmit', { prompt: 'Marked delivery.', isMeta: true });
  assert.match(output.hookSpecificOutput.additionalContext, /FULI is stopped for this session by the person/);
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

test('Codex installed hook holds a marked turn, refreshes in place and claims no transcript boundary', async t => {
  const s = await codexSession(t);
  const output = await s.markedTurn();
  assert.deepEqual(s.calls, [['read_task_preferences', 'fuli-task-synthetic-a']]);
  assert.match(output.hookSpecificOutput.additionalContext, UNCONFIRMED);
  assert.match(output.hookSpecificOutput.additionalContext, /"taskContextToken":"fuli-task-synthetic-a"/);
  const [held] = s.ledger.heldTurns().turns;
  assert.equal(held.owner, transcriptDigest('fuli-task-synthetic-a'), 'the turn names the task it was current for');
  assert.equal(s.state.cursor, 0, 'a refresh imports nothing');
});

test('Codex unresolved turns never settle A or record under it; A can still checkpoint; B gets its own token', async t => {
  const s = await codexSession(t);
  await s.markedTurn();
  await s.quietStop('marked turn');
  await s.quietStop('marked turn, repeated Stop');
  // A mid-run change reaches the next marked turn.
  s.state.revision = 2;
  const next = await s.markedTurn('SYNTHETIC_SECOND_REPLY');
  assert.match(next.hookSpecificOutput.additionalContext, /revision 2/);
  assert.match(next.hookSpecificOutput.additionalContext, /"checkpoint_required":true/);
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
  assert.doesNotMatch(entered.hookSpecificOutput.additionalContext, UNCONFIRMED);
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
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;
    assert.match(context, /start a task explicitly with get_collaboration_preferences/);
    assert.doesNotMatch(context, /First call get_collaboration_preferences|synthetic runtime outage/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
