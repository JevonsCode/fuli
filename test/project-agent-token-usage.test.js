import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordProjectAgentTaskActivity } from '../src/graphiti/project-agent-workflows.js';
import {
  createAgentTokenUsageResolver,
  enrichProjectAgentTaskActivity,
  resolveProjectAgentTaskActivityTokenUsage
} from '../src/agents/token-usage-resolver.js';
import {
  createCodexTokenUsageResolver,
  resolveCodexTokenUsage
} from '../src/agents/codex/token-usage.js';

test('Codex token usage resolves the exact worker session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-token-usage-'));
  try {
    const sessions = join(root, 'sessions', '2026', '10', '09');
    const archived = join(root, 'archived_sessions');
    await mkdir(sessions, { recursive: true });
    await mkdir(archived, { recursive: true });
    await writeFile(join(sessions, 'rollout-parent-session.jsonl'), [
      codexSessionMeta('parent-session'),
      codexTokenCount(900)
    ].join('\n'));
    await writeFile(join(sessions, 'rollout-worker-session.jsonl'), [
      codexSessionMeta('worker-session'),
      '{malformed',
      codexTokenCount(125),
      codexTokenCount(321)
    ].join('\n'));
    await writeFile(join(sessions, 'rollout-malformed-session.jsonl'), [
      '{malformed', codexTokenCount(999)
    ].join('\n'));
    await writeFile(join(sessions, 'rollout-foreign-session.jsonl'), [
      codexSessionMeta('different-session'), codexTokenCount(888)
    ].join('\n'));
    await writeFile(join(sessions, 'rollout-zero-session.jsonl'), [
      codexSessionMeta('zero-session'), codexTokenCount(0)
    ].join('\n'));
    await writeFile(join(archived, 'rollout-archived-session.jsonl'), [
      codexSessionMeta('archived-session'), codexTokenCount(77)
    ].join('\n'));

    const resolver = createCodexTokenUsageResolver({
      sessionsDirectory: join(root, 'sessions'), archivedSessionsDirectory: archived
    });
    assert.deepEqual(await resolver.resolve({ sessionId: 'worker-session' }), {
      source: 'host',
      totalTokens: 321,
      inputTokens: 280,
      outputTokens: 41,
      cachedInputTokens: 90,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: 7
    });
    assert.equal((await resolver.resolve({ sessionId: 'parent-session' })).totalTokens, 900);
    assert.equal((await resolver.resolve({ sessionId: 'zero-session' })).totalTokens, 0);
    assert.equal((await resolver.resolve({ sessionId: 'archived-session' })).totalTokens, 77);
    assert.equal(await resolver.resolve({ sessionId: 'missing-session' }), null);
    assert.equal(await resolver.resolve({ sessionId: 'malformed-session' }), null);
    assert.equal(await resolver.resolve({ sessionId: 'foreign-session' }), null);
    assert.equal(await resolver.resolve({ sessionId: '../parent-session' }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('direct Codex resolver defaults to the .codex session roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-token-default-roots-'));
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = root;
    delete process.env.CODEX_HOME;
    await mkdir(join(root, '.codex', 'sessions'), { recursive: true });
    await mkdir(join(root, '.codex', 'archived_sessions'), { recursive: true });
    await writeFile(join(root, '.codex', 'sessions', 'rollout-default-active-session.jsonl'), [
      codexSessionMeta('default-active-session'), codexTokenCount(13)
    ].join('\n'));
    await writeFile(join(root, '.codex', 'archived_sessions', 'rollout-default-archived-session.jsonl'), [
      codexSessionMeta('default-archived-session'), codexTokenCount(17)
    ].join('\n'));

    assert.equal(
      (await resolveCodexTokenUsage({ sessionId: 'default-active-session' })).totalTokens,
      13
    );
    assert.equal(
      (await resolveCodexTokenUsage({ sessionId: 'default-archived-session' })).totalTokens,
      17
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('shared token usage resolution never falls back from a child worker to its reporter', async () => {
  const calls = [];
  const resolver = createAgentTokenUsageResolver({
    adapters: new Map([['codex', {
      resolve: async (request) => {
        calls.push(request);
        return ['worker-session', 'direct-session'].includes(request.sessionId)
          ? { source: 'host', totalTokens: 12 }
          : null;
      }
    }]])
  });

  assert.deepEqual(await resolver.resolve({
    sourceApplication: 'codex',
    sourceSessionId: 'parent-session',
    workerRuntime: { application: 'codex', sessionId: 'worker-session' }
  }), {
    source: 'host',
    totalTokens: 12,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null
  });
  assert.equal(calls[0].sessionId, 'worker-session');
  assert.equal(await resolver.resolve({
    sourceApplication: 'codex',
    sourceSessionId: 'parent-session',
    workerRuntime: { application: 'codex', sessionId: null }
  }), null);
  assert.equal(await resolver.resolve({
    sourceApplication: 'codex',
    sourceSessionId: 'parent-session',
    workerId: 'worker-without-runtime'
  }), null);
  assert.deepEqual(await resolver.resolve({
    sourceApplication: 'codex',
    sourceSessionId: 'direct-session'
  }), {
    source: 'host',
    totalTokens: 12,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null
  });
});

test('task activity auto-enriches missing usage while explicit zero and null remain authoritative', async () => {
  const captured = [];
  const resolver = {
    resolve: async (input) => {
      captured.push(input);
      return { source: 'host', totalTokens: 42 };
    }
  };
  const base = {
    personalSpaceId: 'space-1',
    personalProjectId: 'project-1',
    taskId: 'task-1',
    idempotencyKey: 'activity-key-1',
    status: 'completed',
    summary: 'worker done',
    agentId: 'agent-1',
    sourceApplication: 'codex',
    sourceSessionId: 'parent-session',
    workerRuntime: { application: 'codex', sessionId: 'worker-session' }
  };
  const application = {
    tokenUsageResolver: resolver,
    personal: {
      recordProjectAgentTaskActivity: async (input) => {
        captured.push(input);
        return { task: { task_id: 'task-1' } };
      }
    }
  };

  await recordProjectAgentTaskActivity(application, base);
  assert.equal(captured[1].token_usage.total_tokens, 42);
  assert.equal(captured[1].source_session_id, 'parent-session');

  captured.length = 0;
  await recordProjectAgentTaskActivity(application, { ...base, idempotencyKey: 'activity-key-2', tokenUsage: {
    source: 'host', totalTokens: 0
  } });
  assert.equal(captured[0].token_usage.total_tokens, 0);
  assert.equal(captured.length, 1);

  captured.length = 0;
  await recordProjectAgentTaskActivity(application, { ...base, idempotencyKey: 'activity-key-3', tokenUsage: null });
  assert.equal(captured[0].token_usage, null);
  assert.equal(captured.length, 1);

  captured.length = 0;
  const explicitAbsent = { ...base, tokenUsage: null, token_usage: { source: 'host', totalTokens: 7 } };
  await recordProjectAgentTaskActivity(application, explicitAbsent);
  assert.equal(captured[0].token_usage, null);
  assert.equal(await resolveProjectAgentTaskActivityTokenUsage(explicitAbsent, resolver), null);

  captured.length = 0;
  await recordProjectAgentTaskActivity(application, { ...base, idempotencyKey: 'activity-key-4', actorKind: 'human' });
  assert.equal(captured[0].token_usage, undefined);
  assert.equal(captured.length, 1);
});

test('automatic token usage failure leaves task activity reportable', async () => {
  const captured = [];
  const enriched = await enrichProjectAgentTaskActivity({
    sourceApplication: 'codex', sourceSessionId: 'session-1'
  }, { resolve: async () => { throw new Error('unavailable'); } });
  assert.deepEqual(enriched, {
    sourceApplication: 'codex', sourceSessionId: 'session-1'
  });
  await recordProjectAgentTaskActivity({
    tokenUsageResolver: { resolve: async () => { throw new Error('unavailable'); } },
    personal: {
      recordProjectAgentTaskActivity: async (input) => {
        captured.push(input);
        return { task: { task_id: 'task-1' } };
      }
    }
  }, {
    personalSpaceId: 'space-1', personalProjectId: 'project-1', taskId: 'task-1',
    idempotencyKey: 'activity-key-5', status: 'failed', summary: 'unavailable',
    agentId: 'agent-1'
  });
  assert.equal(captured.length, 1);
  assert.equal(Object.hasOwn(captured[0], 'token_usage'), false);
});

function codexSessionMeta(id) {
  return JSON.stringify({ type: 'session_meta', payload: { id } });
}

function codexTokenCount(totalTokens) {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: totalTokens - 41,
          output_tokens: 41,
          cached_input_tokens: 90,
          reasoning_output_tokens: 7,
          total_tokens: totalTokens
        }
      }
    }
  });
}
