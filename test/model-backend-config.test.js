import assert from 'node:assert/strict';
import test from 'node:test';

import { readModelBackendConfig } from '../src/model-backends/config.js';

const budget = { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000 };

function valid() {
  return structuredClone({
    version: 1,
    connections: {
      local: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1/', model: 'qwen3.5:4b', secretRef: null },
      shared: { protocol: 'anthropic_messages', endpoint: 'https://api.anthropic.com/v1', model: 'claude-test', secretRef: 'anthropic-main',
        pricing: { currency: 'USD', inputPerMillionTokens: 4, outputPerMillionTokens: 20 } }
    },
    roles: {
      bole: { enabled: true, connection: 'shared', allowedOperations: ['staffing_review'], budget, fallbackToSession: true },
      tonborg: { enabled: true, connection: 'shared', allowedOperations: ['review'], budget: { ...budget, maxCostPerWindow: 2 } },
      jefa: { enabled: false, connection: 'local' }
    }
  });
}

const read = raw => readModelBackendConfig('model-backends.json', { read: () => raw });

function invalid(mutate) {
  const raw = valid();
  mutate(raw);
  const result = read(raw);
  assert.equal(result.state, 'invalid');
  return result.error;
}

test('a missing file is absent and old files without roles configure no role', () => {
  assert.deepEqual(read(null), { state: 'absent' });
  const result = read({ version: 1 });
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.config.roles, {});
});

test('a valid config is normalized with conservative defaults', () => {
  const { state, config } = read(valid());
  assert.equal(state, 'ok');
  assert.equal(config.connections.local.endpoint, 'http://127.0.0.1:11434/v1');
  assert.equal(config.connections.local.reasoningEffort, null);
  assert.equal(read({ version: 1, connections: { local: { ...valid().connections.local, reasoningEffort: 'none' } } })
    .config.connections.local.reasoningEffort, 'none');
  assert.deepEqual(config.roles.bole.egress, { approvedProjects: [], allowUnassigned: false });
  assert.equal(config.roles.tonborg.fallbackToSession, false);
  assert.equal(config.roles.bole.connection, config.roles.tonborg.connection);
  assert.equal(config.roles.jefa.enabled, false);
  assert.equal(Object.isFrozen(config.roles.bole), true);
});

test('invalid configurations are rejected with the field that needs repair', () => {
  assert.match(invalid(raw => { raw.version = 2; }), /version/);
  assert.match(invalid(raw => { raw.roles.astro = raw.roles.bole; }), /astro/);
  assert.match(invalid(raw => { raw.roles.bole.connection = 'missing'; }), /missing/);
  assert.match(invalid(raw => { raw.connections.local.protocol = 'grpc'; }), /protocol/);
  assert.match(invalid(raw => { raw.connections.local.endpoint = 'ftp://models.example.com/v1'; }), /HTTP or HTTPS/);
  assert.match(invalid(raw => { raw.connections.local.endpoint = 'https://user:pass@example.com/v1'; }), /credentials/);
  assert.match(invalid(raw => { raw.connections.shared.secretRef = 'has spaces'; }), /secretRef/);
  assert.match(invalid(raw => { raw.connections.shared.secretRef = null; }), /secretRef/);
  assert.match(invalid(raw => { raw.connections.shared.apiKey = 'sk-inline'; }), /apiKey/);
  assert.match(invalid(raw => { raw.connections.shared.reasoningEffort = 'low'; }), /reasoningEffort/);
  assert.match(invalid(raw => { raw.connections.local.reasoningEffort = 'extreme'; }), /reasoningEffort/);
  assert.match(invalid(raw => { delete raw.roles.bole.budget; }), /budget/);
  assert.match(invalid(raw => { raw.roles.bole.budget.maxOutputTokens = 0; }), /maxOutputTokens/);
  assert.match(invalid(raw => { raw.roles.bole.allowedOperations = ['Bad Op']; }), /allowedOperations/);
  assert.match(invalid(raw => { raw.roles.bole.egress = { approvedProjects: [{ personalSpaceId: 'space' }] }; }), /personalProjectId/);
  assert.match(invalid(raw => {
    raw.roles.jefa = { enabled: true, connection: 'local', allowedOperations: ['plan'], budget: { ...budget, maxCostPerWindow: 1 } };
  }), /unit prices/);
});

test('a gateway header is kept, and one that carries a key or that the request sets is refused', () => {
  const raw = valid();
  raw.connections.local.headers = { 'X-Session-Id': 'synthetic-session' };
  assert.deepEqual(read(raw).config.connections.local.headers, { 'X-Session-Id': 'synthetic-session' });
  assert.match(invalid(next => { next.connections.local.headers = { Authorization: 'Bearer synthetic' }; }), /secretRef/);
  assert.match(invalid(next => { next.connections.local.headers = { 'x-api-key': 'synthetic' }; }), /secretRef/);
  assert.match(invalid(next => { next.connections.local.headers = { 'X-Session-Id': 'a\nb' }; }), /one short line/);
  assert.match(invalid(next => { next.connections.local.headers = { 'bad name': 'x' }; }), /invalid name/);
});

test('a model server on the local network may use plain HTTP', () => {
  const raw = valid();
  raw.connections.local.endpoint = 'http://192.0.2.10:6666/v1';
  const result = read(raw);
  assert.equal(result.state, 'ok');
  assert.equal(result.config.connections.local.endpoint, 'http://192.0.2.10:6666/v1');
});

test('a role has no limit unless the person set one', async () => {
  const { budgetBlock, callLimits, windowStart } = await import('../src/model-backends/budget.js');
  const raw = valid();
  raw.roles.tonborg.budget = {};
  const { budget } = read(raw).config.roles.tonborg;
  assert.deepEqual(Object.values(budget), [null, null, null, null, null, null]);
  const limits = callLimits(budget);
  assert.equal(limits.maxInputTokens, Infinity);
  assert.ok(limits.maxOutputTokens > 0 && limits.timeoutMs > 0, 'a request still names an output size and an end');
  assert.equal(budgetBlock({ budget, pricing: null, window: { reportedTokens: 1e12, reservedTokens: 0 }, estimatedInputTokens: 1e9, maxOutputTokens: 1 }), null);
  assert.ok(windowStart(budget, new Date('2026-11-05T00:00:00Z')));
  raw.roles.tonborg.budget = { maxTokensPerWindow: 10 };
  const { budget: set } = read(raw).config.roles.tonborg;
  assert.equal(budgetBlock({ budget: set, pricing: null, window: { reportedTokens: 9, reservedTokens: 0 }, estimatedInputTokens: 5, maxOutputTokens: 1 }), 'window_tokens');
});

