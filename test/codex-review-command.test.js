// rec#22: Codex's TUI rejects `/flreview` before any hook runs, so the person types
// `fuli review` (or `flreview`) and the Codex prompt hook names the installed Skill.
// Synthetic fixtures only (test/fixtures/capture-project-fixture.js): temporary
// directories and a recording Provider double. No FULI data directory, live
// Provider or client configuration is used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../src/agent-tools.js';
import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { isCodexReviewCommand } from '../src/agents/codex/review-command.js';
import { requestSessionFuliDefault } from '../src/graphiti/session-fuli-switch.js';
import { reviewSkillTrigger } from '../src/setup/command-skill-adapters.js';
import { replaceFuliGlobalInstructions } from '../src/setup/codex-bootstrap.js';
import { claudeEntry, cursorEntry, fixture } from './fixtures/capture-project-fixture.js';

const SESSION = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';
const REVIEW = /run the installed `flreview` Skill as an exact \/flreview invocation/;
const leases = () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} });

// The UserPromptSubmit payload of codex-rs/hooks/src/schema.rs 568-584 (openai/codex 87f3c3284e16).
async function codexPrompt(f, prompt) {
  let context;
  const output = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ session_id: SESSION, turn_id: 'synthetic-turn', transcript_path: null, cwd: f.dirs.novel,
      hook_event_name: 'UserPromptSubmit', model: 'synthetic-model', permission_mode: 'default', prompt }),
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
  for (const line of ['fuli review this file', 'please run fuli review', 'fuli reviews', 'fuli stop', 'flreview now', null]) {
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
