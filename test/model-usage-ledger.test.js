import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';

// U-09 / D-04: one immutable record per actual attempt, deduplicated by
// (requestId, attemptId); logical requests are counted by requestId.

function attempt(overrides = {}) {
  return {
    requestId: 'req-1', attemptId: 'a1', attemptNumber: 1, purpose: 'initial', channel: 'model_api',
    role: 'bole', operation: 'pick', personalSpaceId: 'space', personalProjectId: 'alpha', connectionId: 'local',
    protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', requestedModel: 'qwen', actualModel: 'qwen:4b',
    outputMode: 'json_schema', startedAt: '2026-10-20T10:00:00.000Z', durationMs: 120,
    outcome: 'succeeded', failureClass: null, failureReason: null,
    usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: null, cacheWriteInputTokens: null,
      reasoningTokens: null, definition: 'openai_chat' },
    budgetCeilingTokens: 1000, estimatedCost: null, costCurrency: null, ...overrides
  };
}

test('a duplicate callback for one attempt is stored once', () => {
  const ledger = new ModelUsageLedger(':memory:');
  assert.equal(ledger.record(attempt()), true);
  assert.equal(ledger.record(attempt({ usage: { ...attempt().usage, inputTokens: 999 } })), false);
  const [group] = ledger.usage({});
  assert.equal(group.attempts, 1);
  assert.deepEqual(group.tokens.input, { reported: 50, unknownAttempts: 0 });
});

test('retries are separate attempts of one logical request, by provider and model', () => {
  const ledger = new ModelUsageLedger(':memory:');
  ledger.record(attempt({ outcome: 'failed', failureClass: 'transient', failureReason: 'server_error',
    usage: { ...attempt().usage, inputTokens: null, outputTokens: null, totalTokens: null } }));
  ledger.record(attempt({ attemptId: 'a2', attemptNumber: 2, purpose: 'retry' }));
  ledger.record(attempt({ requestId: 'req-2', role: 'tonborg', protocol: 'anthropic_messages', endpointHost: 'api.anthropic.com',
    actualModel: 'claude-x', estimatedCost: 0.001, costCurrency: 'USD' }));
  const groups = ledger.usage({});
  const bole = groups.find(group => group.role === 'bole');
  assert.equal(bole.provider, 'openai_chat@127.0.0.1:11434');
  assert.equal(bole.model, 'qwen');
  assert.deepEqual(bole.actualModels, ['qwen:4b']);
  assert.equal(bole.channel, 'model_api');
  assert.equal(bole.requests, 1);
  assert.equal(bole.attempts, 2);
  assert.equal(bole.retries, 1);
  assert.equal(bole.failedAttempts, 1);
  assert.equal(bole.failedRequests, 0);
  assert.deepEqual(bole.tokens.total, { reported: 60, unknownAttempts: 1 });
  assert.equal(bole.estimatedCost, null);
  const tonborg = groups.find(group => group.role === 'tonborg');
  assert.deepEqual(tonborg.estimatedCost, { amount: 0.001, currency: 'USD', basis: 'estimate', unknownAttempts: 0 });
  assert.deepEqual(ledger.usage({ role: 'tonborg' }).map(group => group.role), ['tonborg']);
});

test('time ranges filter attempts and the budget window counts unknown usage at its ceiling', () => {
  const ledger = new ModelUsageLedger(':memory:');
  ledger.record(attempt({ startedAt: '2026-10-01T00:00:00.000Z' }));
  ledger.record(attempt({ requestId: 'req-2', startedAt: '2026-10-20T11:00:00.000Z',
    usage: { ...attempt().usage, inputTokens: 40, outputTokens: null, totalTokens: null }, budgetCeilingTokens: 700 }));
  assert.equal(ledger.usage({ from: '2026-10-19T00:00:00.000Z' })[0].requests, 1);
  assert.equal(ledger.usage({ to: '2026-10-02T00:00:00.000Z' })[0].requests, 1);
  assert.deepEqual(ledger.window({ role: 'bole', since: '2026-10-19T12:00:00.000Z' }),
    { reportedTokens: 0, reservedTokens: 700, estimatedCost: 0, unpricedTokens: 700 });
});

test('records keep no prompt text and reject an unknown channel', () => {
  const ledger = new ModelUsageLedger(':memory:');
  const columns = ledger.db.prepare("SELECT name FROM pragma_table_info('model_attempts')").all().map(row => row.name);
  assert.equal(columns.some(name => /prompt|content|message|secret|key$/.test(name)), false);
  assert.throws(() => ledger.record(attempt({ channel: 'browser' })));
});

test('the last served build is the latest model API answer of that role, connection and model; an unproven digest stays unknown', () => {
  const ledger = new ModelUsageLedger(':memory:');
  const digest = 'c'.repeat(64);
  const where = { role: 'bole', connectionId: 'local', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', requestedModel: 'qwen' };
  assert.equal(ledger.lastServed(where), null);
  ledger.record(attempt({ modelDigest: digest }));
  // A failure, a session answer, another role and another model never replace it.
  ledger.record(attempt({ requestId: 'req-2', startedAt: '2026-10-20T11:00:00.000Z', outcome: 'failed', failureClass: 'transient',
    failureReason: 'timeout', modelDigest: 'd'.repeat(64) }));
  ledger.record(attempt({ requestId: 'req-3', startedAt: '2026-10-20T11:00:00.000Z', channel: 'session', connectionId: null,
    protocol: null, endpointHost: null, requestedModel: null, actualModel: null }));
  ledger.record(attempt({ requestId: 'req-4', startedAt: '2026-10-20T11:00:00.000Z', role: 'jefa', modelDigest: 'e'.repeat(64) }));
  ledger.record(attempt({ requestId: 'req-5', startedAt: '2026-10-20T11:00:00.000Z', requestedModel: 'qwen:8b', modelDigest: 'f'.repeat(64) }));
  assert.deepEqual(ledger.lastServed(where), { modelDigest: digest, answeredAt: '2026-10-20T10:00:00.000Z' });
  // A later answer whose backend proved no digest is unknown, never the earlier digest.
  ledger.record(attempt({ requestId: 'req-6', startedAt: '2026-10-20T12:00:00.000Z' }));
  assert.deepEqual(ledger.lastServed(where), { modelDigest: null, answeredAt: '2026-10-20T12:00:00.000Z' });
});
