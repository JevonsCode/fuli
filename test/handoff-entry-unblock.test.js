import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';
import { runCodexLifecycleHook, runCodexLifecycleCommand } from '../src/agents/codex/lifecycle-hook.js';
import { withTranscriptGuard, transcriptDigest, TRANSCRIPT_SCAN_PAGE_LIMIT } from '../src/conversations/transcript-guard.js';
import { syncConversationTranscript } from '../src/conversations/sync-transcript.js';
import { captureWindow } from '../src/conversations/capture-window.js';
import { normalizeCodexRecord, verifyCodexTranscript } from '../src/agents/codex/conversation-transcript.js';
import { beginConversation } from '../src/graphiti/agent-conversations.js';
import { selectedTaskEntryPreferences } from '../src/graphiti/task-entry-preferences.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';

const adapters = [['codex', runCodexLifecycleHook], ['claude_code', runClaudeLifecycleHook]];
const codexAdapter = { normalize: normalizeCodexRecord, verify: verifyCodexTranscript };

for (const mutation of ['clear', 'write']) {
  test(`timed-out capture cannot ${mutation} a later lock holder's guard`, async () => {
    // A separate module graph lets the filesystem port delay a mutation that
    // has already started, beyond capture expiry and the next lock acquisition.
    await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs/promises';
      import { mock } from 'node:test';
      import { tmpdir } from 'node:os';
      import { join, sep } from 'node:path';
      const delayed = [];
      let delay = false;
      const canonical = path => String(path).split(sep).includes('transcript-guards') && String(path).endsWith('.json');
      const call = (name, args, path) => delay && canonical(path)
        ? new Promise((resolve, reject) => delayed.push(() => fs[name](...args).then(resolve, reject)))
        : fs[name](...args);
      mock.module('node:fs/promises', { namedExports: { ...fs,
        rm: (...args) => call('rm', args, args[0]),
        rename: (...args) => call('rename', args, args[1])
      } });
      const { withTranscriptGuard, transcriptDigest } = await import('./src/conversations/transcript-guard.js');
      const { captureWindow } = await import('./src/conversations/capture-window.js');
      const directory = await fs.mkdtemp(join(tmpdir(), 'fuli-guard-late-mutation-'));
      const runtime = join(directory, 'runtime.json');
      const input = { session_id: 'native', transcript_path: join(directory, 'native.jsonl') };
      const state = owner => ({ version: 1, phase: 'scan', owner: transcriptDigest(owner),
        prompt: transcriptDigest('prompt'), scanCursor: 0 });
      try {
        await withTranscriptGuard(runtime, input, 'codex', true, async guard => {
          await guard.write(state('old-owner'));
          delay = true;
          try {
            await captureWindow({ personal: {} }, guard, async (_app, held) => {
              await held['${mutation}'](state('late-old-owner'));
            }, { timeoutMs: 20 });
          } catch (error) { assert.equal(error.code, 'transcript_capture_timeout'); }
          finally { delay = false; }
        });
        await withTranscriptGuard(runtime, input, 'codex', true, guard => guard.write(state('next-owner')));
        await Promise.all(delayed.map(finish => finish()));
        await new Promise(resolve => setImmediate(resolve));
        await withTranscriptGuard(runtime, input, 'codex', true, guard => {
          assert.equal(guard.value?.owner, transcriptDigest('next-owner'));
        });
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    `], { cwd: new URL('..', import.meta.url), timeout: 5000 });
  });
}

// rec#16: expiry revokes only the operation's view of the guard. The late
// operation can neither read nor write it, nor reach the Provider; the hook
// that still holds the lock records how far the handoff got.
test('an expired capture fences its late operation but leaves the lock holder able to record the handoff', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-window-fence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'runtime.json');
  const input = { session_id: 'native', transcript_path: join(directory, 'native.jsonl') };
  const state = { version: 1, phase: 'scan', owner: transcriptDigest('old-owner'), prompt: transcriptDigest('prompt'),
    scanCursor: 0, userMessages: 0 };
  const requests = [];
  const app = { personal: { conversation: async (...request) => { requests.push(request); return { status: 'saved' }; } } };
  await withTranscriptGuard(runtime, input, 'codex', true, async guard => {
    await guard.write(state);
    let resume, finished, began;
    const gate = new Promise(resolve => { resume = resolve; });
    const done = new Promise(resolve => { finished = resolve; });
    const started = new Promise(resolve => { began = resolve; });
    const late = [];
    const deadline = new AbortController();
    const window = captureWindow(app, guard, async (port, held) => {
      try {
        began();
        await gate;
        for (const step of [() => held.value, () => held.write({ ...state, scanCursor: 9 }), () => held.clear(),
          () => port.personal.conversation('append', {})]) {
          try { await step(); late.push('ran'); } catch (error) { late.push(error.code); }
        }
      } finally { finished(); }
    }, { signal: deadline.signal, timeoutMs: 30_000 });
    await started;
    deadline.abort();
    await assert.rejects(window, { code: 'transcript_capture_timeout' });
    resume();
    await done;
    assert.deepEqual(late, Array(4).fill('transcript_capture_timeout'));
    assert.deepEqual(requests, []);
    assert.equal(guard.value.scanCursor, 0, 'the late write never landed');
    await guard.write({ ...guard.value, nextOwner: transcriptDigest('entered'), entryEnd: 10 });
  });
  await withTranscriptGuard(runtime, input, 'codex', true, guard => {
    assert.equal(guard.value.nextOwner, transcriptDigest('entered'));
    assert.equal(guard.expired, false, 'an entered handoff does not expire with the lifetime');
  });
});

async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'fuli-handoff-unblock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = join(dir, 'runtime.json');
  const input = { cwd: '/synthetic/project', session_id: 'synthetic-native', prompt: 'next real task',
    transcript_path: join(dir, 'native.jsonl') };
  const records = source === 'codex'
    ? [{ type: 'session_meta', payload: { id: input.session_id } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'host-decorated unmatched task' }] } }]
    : [{ sessionId: input.session_id, type: 'user', message: { content: 'host-decorated unmatched task' } }];
  await writeFile(input.transcript_path, records.map(x => JSON.stringify(x)).join('\n') + '\n');
  let token = 'old-token', cursor = 0;
  const calls = [], events = [];
  const app = { config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }), personal: {
    currentTaskContext: async () => ({ token, entry_via: 'hook', session_id: input.session_id,
      source_application: source, personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project', project_agent_id: 'engineer' }),
    conversation: async (operation, query) => {
      calls.push({ operation, ...query });
      if (query.mode === 'policy') return { enabled: true };
      if (query.mode === 'session') return { cursor, initialized: true };
      if (operation === 'append') { events.push(...query.events); cursor = query.cursor; return { status: 'saved' }; }
      if (operation === 'boundary') { cursor = query.cursor; return { status: 'saved', cursor, omitted: query.fallback_recovery }; }
    }
  } };
  let entries = 0;
  const dependencies = { readInput: async () => input, write: () => {}, resolveRuntimeOptions: () => ({ runtimeConfigPath: runtime }),
    openApplication: () => app, createLeases: () => ({ withGraphLease: async (_owner, run) => run() }),
    callTool: async (_app, name) => {
      assert.equal(name, 'begin_task_context'); token = `fresh-token-${++entries}`;
      return { taskContextToken: token, effective_preferences: [{ instruction: 'Preserve this complete preference.' }],
        agent_receipt: { required: true, markdown: 'FULI Agent: current owner' } };
    } };
  return { dir, runtime, input, app, calls, events, dependencies, entries: () => entries };
}

// The hook deadline and capture windows run on a mocked clock, so real
// transcript and guard I/O (fsync on a loaded host) cannot spend a capture
// budget before the hung request under test is reached. Once it is, exactly
// one capture budget (a quarter of the hook budget) elapses; that must expire
// the request. If it does not, the hook deadline is let through so the test
// reports the failure instead of hanging.
async function commandWithOneExpiredCapture(t, hookBudgetMs, dependencies, reached) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = runCodexLifecycleCommand(['--event', 'UserPromptSubmit', '--timeout-ms', String(hookBudgetMs)], dependencies);
  const signal = await Promise.race([reached, running.then(() => null)]);
  if (!signal) return { result: await running, expired: false };
  t.mock.timers.tick(hookBudgetMs / 4);
  const expired = signal.aborted;
  if (!expired) t.mock.timers.tick(hookBudgetMs);
  return { result: await running, expired };
}

for (const stage of ['before entry', 'after entry']) {
  test(`capture RPC hung ${stage} must leave time to deliver valid context through the command writer`, async t => {
    const f = await fixture(t, 'codex');
    const conversation = f.app.personal.conversation;
    let policyReads = 0, output = '', finishLate, hang;
    const reached = new Promise(resolve => { hang = resolve; });
    f.app.personal.conversation = async (operation, query, options) => {
      if (query.mode === 'policy' && ++policyReads === (stage === 'before entry' ? 1 : 2)) {
        hang(options.signal);
        return new Promise(resolve => { finishLate = resolve; }); // May ignore cancellation.
      }
      return conversation(operation, query, options);
    };
    // A quarter of the hook budget goes to each capture, so one hung capture
    // leaves the rest of the deadline for task entry.
    const { result, expired } = await commandWithOneExpiredCapture(t, 1000,
      { ...f.dependencies, write: value => { output += value; } }, reached);
    assert.equal(typeof finishLate, 'function', `the capture RPC ${stage} was reached and hung`);
    assert.equal(expired, true, 'one capture budget expires the hung capture');
    assert.equal(result.timedOut, false);
    assert.equal(f.entries(), 1);
    const delivered = JSON.parse(output);
    assert.match(delivered.hookSpecificOutput.additionalContext, /fresh-token-1/);
    assert.match(delivered.hookSpecificOutput.additionalContext, /Preserve this complete preference/);
    assert.doesNotMatch(output, /No valid Hook task context|First call get_collaboration_preferences/);
    assert.deepEqual(f.events, []);
    const calls = f.calls.length;
    finishLate({ enabled: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, calls, 'a revoked capture cannot issue late Provider writes/reads');
    assert.equal(output.trim().split('\n').length, 1, 'a late capture cannot replace or repeat the delivered context');
  });
}

test('conversation recovery inside real task entry cannot hide the already-created token and preferences', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { ProviderTaskContextRegistry } = await import('../src/mcp/provider-task-context-registry.js');
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
    personal: { conversation: async () => new Promise(() => {}) },
    taskContextRegistry: new ProviderTaskContextRegistry({ beginTaskContext: async q => ({ ...q, checkpoint: null }) }, 'space') };
  let timeout;
  try {
    const result = await Promise.race([beginTaskFromPreferences(app, {
      context: { personal_space_id: 'space', personal_project_id: 'project', project_agent_id: 'engineer' },
      effective_preferences: [{ instruction: 'available complete preference' }],
      agent_receipt: { required: true, markdown: 'FULI Agent: engineer' }
    }, { sessionId: 'native', sourceApplication: 'codex', sourceSessionId: 'native' }),
    new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1500); })]);
    assert.notEqual(result, null);
    assert.match(result.taskContextToken, /^fuli-task-/);
    assert.equal(result.effective_preferences[0].instruction, 'available complete preference');
    assert.equal(result.conversation.status, 'unsaved');
  } finally { clearTimeout(timeout); }
});

test('the actual Provider HTTP client receives and aborts the capture-only request before task entry times out', async t => {
  const f = await fixture(t, 'codex');
  let aborted = false, output = '', hang;
  const reached = new Promise(resolve => { hang = resolve; });
  f.app.personal = new GraphitiProviderClient({ baseUrl: 'http://synthetic.invalid', accessToken: 'synthetic-access',
    fetchImpl: async (url, request) => {
      if (new URL(url).pathname === '/v1/task-context-sessions/current') return Response.json({
        token: 'old-token', personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project',
        project_agent_id: 'engineer', source_application: 'codex', session_id: f.input.session_id, entry_via: 'hook'
      });
      assert.equal(JSON.parse(request.body).mode, 'policy');
      const pending = new Promise((_, reject) => request.signal.addEventListener('abort', () => {
        aborted = true; reject(request.signal.reason);
      }, { once: true }));
      hang(request.signal);
      return pending;
    } });
  const { result, expired } = await commandWithOneExpiredCapture(t, 160,
    { ...f.dependencies, write: value => { output += value; } }, reached);
  assert.equal(expired, true, 'one capture budget aborts the Provider request');
  assert.equal(result.timedOut, false);
  assert.equal(aborted, true);
  assert.equal(f.entries(), 1);
  assert.match(output, /fresh-token-1/);
});

for (const [source, run] of adapters) {
  test(`${source}: pending scan must deliver fresh complete preferences without importing the uncertain tail`, async t => {
    const f = await fixture(t, source);
    for (let turn = 1; turn <= 2; turn++) {
      f.input.prompt = `next real task ${turn}`;
      const result = await run(['--event', 'UserPromptSubmit'], f.dependencies);
      assert.match(result.hookSpecificOutput?.additionalContext ?? '', new RegExp(`fresh-token-${turn}`));
      assert.match(result.hookSpecificOutput.additionalContext, /Preserve this complete preference/);
      assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /First call get_collaboration_preferences/);
      assert.equal(f.entries(), turn);
    }
    assert.deepEqual(f.events, [], 'uncertain native text is never submitted to either owner');
    assert.ok(f.calls.some(x => x.fallback_recovery), 'a verified EOF is quarantined, rather than attributed to the next task');
  });

  test(`${source}: held transcript lock cannot suppress preferences or mutate the guard`, async t => {
    const f = await fixture(t, source);
    await withTranscriptGuard(f.runtime, f.input, source, true, async guard => {
      const result = await run(['--event', 'UserPromptSubmit'], f.dependencies);
      assert.match(result.hookSpecificOutput?.additionalContext ?? '', /fresh-token-1/);
      assert.equal(guard.value, null);
      assert.deepEqual(f.events, []);
    });
  });

  test(`${source}: post-entry boundary failure preserves delivered context and never begins twice`, async t => {
    const f = await fixture(t, source);
    f.app.personal.conversation = async (_op, query) => {
      if (query.mode === 'policy') return { enabled: true };
      if (query.mode === 'session') return { cursor: 0, initialized: false };
      throw new Error('synthetic boundary unavailable');
    };
    const result = await run(['--event', 'UserPromptSubmit'], f.dependencies);
    assert.match(result.hookSpecificOutput?.additionalContext ?? '', /fresh-token-1/);
    assert.equal(f.entries(), 1);
    assert.match(result.systemMessage, /transcript|Transcript/);
  });

  // Both hooks re-read the current task for isMeta turns instead of trusting
  // them (rec#15, rec#28): claude-code-lifecycle-hook.test.js and codex-lifecycle-hook.test.js.

  test(`${source}: task-entry failure is not retried as a transcript failure`, async t => {
    const f = await fixture(t, source); let calls = 0;
    await assert.rejects(run(['--event', 'UserPromptSubmit'], { ...f.dependencies,
      callTool: async () => { calls++; throw new Error('synthetic task entry failed'); } }), /task entry failed/);
    assert.equal(calls, 1);
  });
}

test('guard lifetime expires from creation even when retries keep updating it', async t => {
  const f = await fixture(t, 'codex');
  const state = { version: 1, phase: 'scan', owner: transcriptDigest('old-token'), prompt: transcriptDigest(f.input.prompt),
    scanCursor: 0, userMessages: 0, createdAt: Date.now() - 10 * 60_000, updatedAt: Date.now() };
  await withTranscriptGuard(f.runtime, f.input, 'codex', true, guard => guard.write(state));
  f.app.personal.currentTaskContext = async () => { assert.fail('expired guards must not scan or look up old ownership'); };
  const result = await withTranscriptGuard(f.runtime, f.input, 'codex', true,
    guard => syncConversationTranscript(f.app, f.input, 'codex', codexAdapter, guard));
  assert.match(result.reason, /expired|lifetime|TTL/i);
  assert.deepEqual(f.calls, []);
});

test('guard scan budget is cumulative across restarts and never imports an over-budget prefix', async t => {
  const f = await fixture(t, 'codex');
  await withTranscriptGuard(f.runtime, f.input, 'codex', true, guard => guard.write({ version: 1, phase: 'scan',
    owner: transcriptDigest('old-token'), prompt: transcriptDigest(f.input.prompt), scanCursor: 0, scanPages: 100_000, userMessages: 0 }));
  const result = await withTranscriptGuard(f.runtime, f.input, 'codex', true,
    guard => syncConversationTranscript(f.app, f.input, 'codex', codexAdapter, guard));
  assert.match(result.reason, /scan.*limit|scan.*budget/i);
  assert.deepEqual(f.events, []);
  const files = await readdir(join(f.dir, 'transcript-guards'));
  const saved = JSON.parse(await readFile(join(f.dir, 'transcript-guards', files[0]), 'utf8'));
  assert.equal(saved.scanCursor, 0);
});

test('legacy guards without a creation time expire without restarting their scan', async t => {
  const f = await fixture(t, 'codex');
  await withTranscriptGuard(f.runtime, f.input, 'codex', true, guard => guard.write({ version: 1, phase: 'scan',
    owner: transcriptDigest('old-token'), prompt: transcriptDigest(f.input.prompt), scanCursor: 0 }));
  const [name] = await readdir(join(f.dir, 'transcript-guards'));
  const path = join(f.dir, 'transcript-guards', name);
  const value = JSON.parse(await readFile(path, 'utf8'));
  delete value.createdAt; delete value.updatedAt;
  await writeFile(path, JSON.stringify(value));
  f.app.personal.currentTaskContext = async () => { assert.fail('legacy scan must not restart'); };
  const result = await withTranscriptGuard(f.runtime, f.input, 'codex', true,
    guard => syncConversationTranscript(f.app, f.input, 'codex', codexAdapter, guard));
  assert.match(result.reason, /expired/);
});

test('one more oversized page exhausts the saved scan budget and a retry reads no more bytes', async t => {
  const f = await fixture(t, 'codex');
  await writeFile(f.input.transcript_path, JSON.stringify({ type: 'session_meta', payload: { id: f.input.session_id } })
    + '\n' + 'x'.repeat(2 * 1024 * 1024) + '\n');
  await withTranscriptGuard(f.runtime, f.input, 'codex', true, guard => guard.write({ version: 1, phase: 'scan',
    owner: transcriptDigest('old-token'), prompt: transcriptDigest(f.input.prompt), scanCursor: 0,
    scanPages: TRANSCRIPT_SCAN_PAGE_LIMIT - 1, userMessages: 0 }));
  let cursor;
  for (let attempt = 0; attempt < 2; attempt++) await withTranscriptGuard(f.runtime, f.input, 'codex', true, async guard => {
    const result = await syncConversationTranscript(f.app, f.input, 'codex', codexAdapter, guard);
    assert.match(result.reason, /scan.*budget|scan.*limit/);
    assert.equal(guard.value.scanPages, TRANSCRIPT_SCAN_PAGE_LIMIT);
    if (attempt === 0) cursor = guard.value.scanCursor;
    else assert.equal(guard.value.scanCursor, cursor);
  });
  assert.deepEqual(f.events, []);
});

test('a fresh native chat never injects an unrelated latest checkpoint; same-session recovery remains', async () => {
  const requests = [];
  let same = false;
  const checkpoint = { summary: 'unrelated migration was not performed', status: 'reported' };
  const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }), personal: {
    conversation: async (operation, q) => {
      requests.push(q);
      if (q.mode === 'session') return { conversation_id: same ? 'same-chat' : null };
      if (q.mode === 'list') return { conversations: [{ id: 'unrelated-chat' }] };
      if (q.mode === 'context') return { context: { latest_checkpoint: checkpoint, messages: [] } };
      return { status: 'saved' };
    }
  } };
  const task = { token: 'task', projectAgentId: 'lead', personalProjectId: 'project', sessionId: 'native', sourceApplication: 'codex' };
  const fresh = await beginConversation(app, task);
  assert.equal(fresh.recovery, null);
  // rec#10 D-27.6: a pointer to the latest conversation of this scope, no context read.
  assert.deepEqual(fresh.recent_conversation, { id: 'unrelated-chat', updated_at: null });
  assert.equal(requests.some(q => q.mode === 'context'), false);
  assert.doesNotMatch(JSON.stringify(fresh), /migration was not performed/);
  same = true;
  const continued = await beginConversation(app, task);
  assert.deepEqual(continued.recovery.latest_checkpoint, checkpoint);
});

for (const management of [{ status: 'degraded', managers: [{ agent_id: 'manager' }] }, { status: 'not_managed', managers: [] }]) {
  test(`entry ${management.status} omits team/judgment but preserves owner, preferences and role memory`, async () => {
    let teamReads = 0;
    const app = { config: { personal: { spaceId: 'space' } },
      employees: { taskEntry: async () => management },
      judgment: { policy: async () => { throw new Error('must not read judgment without team entry'); } },
      searchKnowledge: async () => ({ facts: [], entities: [] }), personal: {
        collaborationPreferences: async () => ({ personal_space_id: 'space', personal_project_id: 'project',
          project_agent_id: 'lead', effective_preferences: [{ instruction: 'Keep this preference.' }] }),
        getProjectAgentMemory: async q => ({ personal_space_id: q.personalSpaceId, personal_project_id: q.personalProjectId,
          agent_id: q.agentId, scope: q.personalProjectId === null ? 'private_agent_global' : 'private_agent_project',
          revision: 4, current: { agent_id: q.agentId, revision: 4, memory: { summary: 'own role memory' } } }),
        getPersonalProject: async () => ({ profile: { name: 'project' } }),
        listProjectAgentTasks: async () => [],
        getProjectAgentCoordinationPolicy: async () => { teamReads++; throw new Error('must not read team'); }
      } };
    const value = await selectedTaskEntryPreferences(app, { personalProjectId: 'project', status: 'matched' },
      { sourceApplication: 'codex', sessionId: 'native', taskPrompt: null, agentInvocation: true, agentToolName: 'begin_task_context' },
      { status: 'ready', reason: 'explicit_agent', agent: { agentId: 'lead', memoryScope: 'reviewed_agent', profile: { name: 'Lead' } } }, async () => {});
    const entry = compactTaskContext(value);
    assert.equal(entry.judgment_context, undefined);
    assert.equal(entry.project_agent_context.team, undefined);
    assert.equal(entry.project_agent_context.team_guidance, undefined);
    assert.equal(entry.project_agent_context.memory.revision, 4);
    assert.match(entry.agent_receipt.markdown, /Lead/);
    assert.equal(entry.effective_preferences[0].instruction, 'Keep this preference.');
    assert.equal(teamReads, 0);
  });
}
