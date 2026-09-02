import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/app/application-error.js';
import { TaskContextRegistry } from '../src/mcp/task-context-registry.js';
import { errorToolResult } from '../src/mcp/tool-result.js';

test('in-memory task contexts preserve turn metadata and isolate identical session IDs by client', () => {
  let token = 0;
  const registry = new TaskContextRegistry({ tokenFactory: () => `token-${++token}` });
  const codex = registry.begin({
    sessionId: 'shared-session', turnId: 'codex-turn', personalProjectId: 'project-1',
    sourceApplication: 'codex', sourceSessionId: 'codex-host'
  });
  const cursor = registry.begin({
    sessionId: 'shared-session', turnId: 'cursor-turn', personalProjectId: 'project-1',
    sourceApplication: 'cursor', sourceSessionId: 'cursor-host'
  });

  assert.equal(codex.turnId, 'codex-turn');
  assert.equal(cursor.turnId, 'cursor-turn');
  assert.equal(registry.context(codex.token, 'codex').sourceSessionId, 'codex-host');
  assert.equal(registry.context(cursor.token, 'cursor').sourceSessionId, 'cursor-host');
  assert.throws(
    () => registry.context(codex.token, 'cursor'),
    (error) => error instanceof ApplicationError && error.code === 'not_found'
  );
  assert.equal(registry.verify('shared-session', 'claude_code').status, 'not_started');
});

test('in-memory task contexts expose the pending token and enforce source on writes', () => {
  const registry = new TaskContextRegistry({ tokenFactory: () => 'token-one' });
  const task = registry.begin({ sessionId: 'session-1', sourceApplication: 'codex' });

  assert.equal(registry.verify('session-1', 'codex').task_context_token, task.token);
  assert.throws(
    () => registry.prepare(task.token, { fingerprint: 'a' }, 'cursor'),
    (error) => error instanceof ApplicationError && error.code === 'not_found'
  );
  assert.throws(
    () => registry.checkpoint(task.token, { disposition: 'retain_nothing' }, 'cursor'),
    (error) => error instanceof ApplicationError && error.code === 'not_found'
  );
});

test('in-memory task contexts fail explicitly instead of discarding atomic Agent memory', () => {
  const registry = new TaskContextRegistry({ tokenFactory: () => 'token-memory' });
  const task = registry.begin({ sessionId: 'session-memory', sourceApplication: 'codex' });

  let thrown;
  try {
    registry.prepare(
      task.token,
      { fingerprint: 'memory-fingerprint' },
      'codex',
      { expected_revision: 0, memory: { summary: 'Must not disappear.' } }
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ApplicationError);
  assert.match(thrown.message, /durable Agent memory/i);
  assert.deepEqual(errorToolResult(thrown).structuredContent.error, {
    code: 'validation',
    message: thrown.message
  });
});

test('capacity pressure rejects a new session instead of invalidating unfinished tokens', () => {
  let token = 0;
  const registry = new TaskContextRegistry({ tokenFactory: () => `token-${++token}` });
  const first = registry.begin({ sessionId: 'session-0', sourceApplication: 'codex' });
  for (let index = 1; index < 256; index += 1) {
    registry.begin({ sessionId: `session-${index}`, sourceApplication: 'codex' });
  }

  assert.throws(
    () => registry.begin({ sessionId: 'session-over-capacity', sourceApplication: 'codex' }),
    (error) => error instanceof ApplicationError && error.code === 'validation'
  );
  assert.equal(registry.context(first.token, 'codex').sessionId, 'session-0');
  assert.equal(
    registry.checkpoint(first.token, {
      disposition: 'retain_nothing', reason: 'Still active.'
    }, 'codex').checkpoint.phase,
    'complete'
  );
  const replacement = registry.begin({
    sessionId: 'session-after-complete', sourceApplication: 'codex'
  });
  assert.equal(replacement.sessionId, 'session-after-complete');
  assert.throws(
    () => registry.context(first.token, 'codex'),
    (error) => error instanceof ApplicationError && error.code === 'not_found'
  );
});

test('checkpoint fingerprint conflicts are controlled validation errors', () => {
  const registry = new TaskContextRegistry({ tokenFactory: () => 'token-fingerprint' });
  const task = registry.begin({ sessionId: 'session-fingerprint', sourceApplication: 'codex' });
  registry.prepare(task.token, {
    disposition: 'retain_nothing', reason: 'Original review.', fingerprint: 'a'
  }, 'codex');

  for (const operation of [
    () => registry.prepare(task.token, {
      disposition: 'retain_nothing', reason: 'Changed review.', fingerprint: 'b'
    }, 'codex'),
    () => registry.checkpoint(task.token, {
      disposition: 'retain_nothing', reason: 'Changed review.', fingerprint: 'b'
    }, 'codex')
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof ApplicationError && error.code === 'validation'
    );
  }

  assert.equal(registry.context(task.token, 'codex').checkpoint.phase, 'prepare');
  assert.equal(registry.checkpoint(task.token, {
    disposition: 'retain_nothing', reason: 'Original review.', fingerprint: 'a'
  }, 'codex').checkpoint.phase, 'complete');
});

test('context snapshots cannot mutate registry identity or strand a token', () => {
  const registry = new TaskContextRegistry({ tokenFactory: () => 'token-snapshot' });
  const task = registry.begin({
    sessionId: 'session-snapshot', sourceApplication: 'codex',
    sourceSessionId: 'codex-host'
  });
  const snapshot = registry.context(task.token, 'codex');
  snapshot.sessionId = 'mutated-session';
  snapshot.sourceApplication = 'cursor';

  assert.equal(registry.context(task.token, 'codex').sessionId, 'session-snapshot');
  assert.equal(registry.verify('session-snapshot', 'codex').status, 'checkpoint_required');
});

test('ephemeral MCP process IDs do not split one logical client session', () => {
  let token = 0;
  const registry = new TaskContextRegistry({ tokenFactory: () => `token-${++token}` });
  const first = registry.begin({
    sessionId: 'logical-session', sourceApplication: 'claude_code',
    sourceSessionId: 'hook-process-one'
  });
  const second = registry.begin({
    sessionId: 'logical-session', sourceApplication: 'claude_code',
    sourceSessionId: 'hook-process-two'
  });

  assert.throws(
    () => registry.context(first.token, 'claude_code'),
    (error) => error instanceof ApplicationError && error.code === 'not_found'
  );
  assert.equal(registry.context(second.token, 'claude_code').sourceSessionId, 'hook-process-two');
});

test('blank lifecycle identifiers are controlled validation errors', () => {
  const registry = new TaskContextRegistry();

  for (const operation of [
    () => registry.begin({ sessionId: '   ', sourceApplication: 'codex' }),
    () => registry.context('\t', 'codex'),
    () => registry.verify('\n', 'codex')
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof ApplicationError && error.code === 'validation'
    );
  }
});
