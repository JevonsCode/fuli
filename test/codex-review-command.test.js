// rec#22: Codex's TUI rejects `/flreview` before any hook runs, so the person types
// `fuli review` (or `flreview`) and the Codex prompt hook names the installed Skill.
// Synthetic fixtures only (test/fixtures/capture-project-fixture.js): temporary
// directories and a recording Provider double. No FULI data directory, live
// Provider or client configuration is used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { runCodexLifecycleCommand, runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { isCodexReviewCommand } from '../src/agents/codex/review-command.js';
import { requestSessionFuliDefault } from '../src/graphiti/session-fuli-switch.js';
import { reviewSkillTrigger } from '../src/setup/command-skill-adapters.js';
import { replaceFuliGlobalInstructions } from '../src/setup/codex-bootstrap.js';
import { claudeEntry, cursorEntry, fixture } from './fixtures/capture-project-fixture.js';

const SESSION = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';
const REVIEW = /run the installed `flreview` Skill as an exact \/flreview invocation/;
const leases = () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} });

// The UserPromptSubmit payload of codex-rs/hooks/src/schema.rs 568-584 (openai/codex 87f3c3284e16).
const payload = (prompt, cwd = '/synthetic') => ({ session_id: SESSION, turn_id: 'synthetic-turn', transcript_path: null,
  cwd, hook_event_name: 'UserPromptSubmit', model: 'synthetic-model', permission_mode: 'default', prompt });

async function codexPrompt(f, prompt) {
  let context;
  const output = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => payload(prompt, f.dirs.novel),
    write: () => {}, resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }),
    openApplication: () => f.app, createLeases: leases, captureTimeoutMs: 30_000,
    callTool: async (app, name, input, request) => {
      const result = await callAgentTool(app, name, input, request);
      if (name === 'begin_task_context') context = result;
      return result;
    } });
  return { output, context };
}

test('only an exact review line is the Codex review command', () => {
  for (const line of ['fuli review', '  FULI  Review ', 'flreview', 'FLReview\n', '/flreview', '$fuli review']) {
    assert.equal(isCodexReviewCommand(line), true, line);
  }
  for (const line of ['fuli review this file', 'please run fuli review', 'fuli reviews', 'fuli stop', 'flreview now', 'fuli\nreview', 'fuli\r\nreview', null]) {
    assert.equal(isCodexReviewCommand(line), false, String(line));
  }
});

test('Codex: `fuli review` reaches the model with its task entry and names the installed flreview Skill', async (t) => {
  const f = await fixture(t);
  for (const line of ['fuli review', 'flreview']) {
    const { output, context } = await codexPrompt(f, line);
    assert.equal(output.decision, undefined, 'the review is the model\'s work, not blocked');
    assert.ok(context.taskContextToken, 'the review keeps the ordinary FULI task entry');
    assert.match(output.hookSpecificOutput.additionalContext, REVIEW, line);
  }
  const ordinary = await codexPrompt(f, 'Explain what fuli review does.');
  assert.doesNotMatch(ordinary.output.hookSpecificOutput.additionalContext, /flreview/, 'a sentence is an ordinary prompt');
});

test('Codex: a session FULI is off for answers `fuli review` in the hook and starts no review', async (t) => {
  const f = await fixture(t);
  requestSessionFuliDefault(f.app, { newSessions: 'off' });
  const { output, context } = await codexPrompt(f, 'fuli review');
  assert.equal(context, undefined);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /^FULI: FULI 在本会话未启用，未开始知识复核。输入 fuli start 启用后，再输入 fuli review。/);
});

test('Claude Code and Cursor keep their native /flreview Skill command; their hooks add nothing', async (t) => {
  const f = await fixture(t);
  const claude = await claudeEntry(f, f.dirs.novel, { session: 'synthetic-claude-review', prompt: '/flreview' });
  assert.equal(claude.output.decision, undefined);
  assert.doesNotMatch(JSON.stringify(claude.output), /installed `flreview` Skill/);
  const cursor = await cursorEntry(f, f.dirs.novel, { session: 'synthetic-cursor-review', prompt: '/flreview' });
  assert.deepEqual(cursor.output, { continue: true });
  assert.equal(reviewSkillTrigger('claude-code').userCommand, '/flreview');
  assert.equal(reviewSkillTrigger('cursor').userCommand, '/flreview');
});

test('the Codex bootstrap no longer pays every session for a `/flreview` line Codex never delivers', () => {
  const managed = replaceFuliGlobalInstructions('');
  assert.doesNotMatch(managed, /flreview/);
  assert.equal(reviewSkillTrigger('codex').userCommand, 'fuli review');
});

// Dot review of #255: when the hook cannot confirm the session's state, the review line is held
// back instead of reaching the model with the "continue without FULI" fallback.
async function unverified(prompt, { timeoutMs, ...dependencies }) {
  let written = '';
  const result = await runCodexLifecycleCommand(['--event', 'UserPromptSubmit', ...(timeoutMs ? ['--timeout-ms', String(timeoutMs)] : [])], {
    readInput: async () => payload(prompt), resolveRuntimeOptions: () => ({ runtimeConfigPath: '/synthetic/runtime.json' }),
    write: value => { written += value; }, ...dependencies });
  return { result, output: JSON.parse(written) };
}

test('Codex: a review line is blocked when the hook fails before it can confirm the session', async () => {
  const failing = { openApplication: () => { throw new Error('synthetic runtime failure'); } };
  const { result, output } = await unverified('fuli review', failing);
  assert.equal(result.timedOut, false);
  assert.deepEqual(Object.keys(output), ['decision', 'reason']);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /^FULI: FULI 无法确认本会话的启停状态，未开始知识复核。请稍后重新输入 fuli review/);
  assert.match(output.reason, /fuli session status/);
  const ordinary = await unverified('Plan the chapter.', failing);
  assert.equal(ordinary.output.decision, undefined, 'an ordinary prompt keeps the fail-open fallback');
  assert.match(ordinary.output.hookSpecificOutput.additionalContext, /First call get_collaboration_preferences/);
});

test('Codex: a review line is blocked when the hook times out before it can confirm the session', async () => {
  const hanging = { openApplication: () => ({ close: async () => {} }),
    createLeases: () => ({ withGraphLease: (_owner, _operation, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }), close: async () => {} }) };
  const { result, output } = await unverified('flreview', { ...hanging, timeoutMs: 40 });
  assert.equal(result.timedOut, true);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /无法确认本会话的启停状态，未开始知识复核/);
  assert.equal(output.hookSpecificOutput, undefined, 'nothing tells the model to continue');
});
