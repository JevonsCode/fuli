import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createModelBackendPort } from '../src/model-backends/port.js';
import { readModelBackendConfig } from '../src/model-backends/config.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';
import { openAiStream, sse } from './fixtures/model-transport.js';

// rec#8 C1-C14 for the shared port. Every model call goes to an injected fake
// transport; nothing here reaches a real or paid model.

const KEYS = { 'anthropic-main': 'sk-ant-SECRET-1234567890', 'jev-main': 'jev-SECRET-0987654321' };
const NOW = new Date('2026-10-20T12:00:00.000Z');

function role(connection, extra = {}) {
  return {
    enabled: true, connection, allowedOperations: ['pick', 'plan'],
    egress: { approvedProjects: [{ personalSpaceId: 'space', personalProjectId: 'alpha' }], allowUnassigned: false },
    budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000 },
    fallbackToSession: true, ...extra
  };
}

function config(roles, connections = {}) {
  return {
    version: 1,
    connections: {
      local: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: null },
      claude: { protocol: 'anthropic_messages', endpoint: 'https://api.anthropic.com/v1', model: 'claude-test',
        secretRef: 'anthropic-main', pricing: { currency: 'USD', inputPerMillionTokens: 4, outputPerMillionTokens: 20 } },
      jev: { protocol: 'typesafe_systemone', endpoint: 'https://api.typesafe.ai/v1', model: 'jev-1.13.0', secretRef: 'jev-main' },
      ...connections
    },
    roles
  };
}

function request(overrides = {}) {
  return {
    role: 'bole', operation: 'pick', requestId: 'req-1', sourceEventId: 'event-1',
    scope: { personalSpaceId: 'space', personalProjectId: 'alpha', sessionRef: 'codex:thread-1' },
    versions: { evidence: 'ev-1', policy: 'pol-1' },
    instructions: 'Which Agent should take the next review?',
    evidence: [{ id: 'e1', personalProjectId: 'alpha', text: 'Ada finished three reviews this week.' }],
    output: { type: 'choice', options: [{ id: 'ada', description: 'Ada, reviewer' }, { id: 'bo', description: 'Bo, writer' }] },
    ...overrides
  };
}

const answer = (overrides = {}) => JSON.stringify({ decision: 'propose', payload: { choice: 'ada' },
  reason: 'Ada has recent review evidence.', evidenceIds: ['e1'], uncertainty: null, ...overrides });

function anthropicStream(content, { start = { input_tokens: 100, output_tokens: 1 }, deltas = [{ output_tokens: 12 }],
  stopReason = 'end_turn', model = 'claude-test-actual' } = {}) {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { model, usage: start } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } },
    ...deltas.slice(0, -1).map(usage => ({ event: 'message_delta', data: { type: 'message_delta', delta: {}, usage } })),
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason }, usage: deltas.at(-1) } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ]);
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers } });

function harness(roles, { connections, responses = [], keys = KEYS, raw, ledger = new ModelUsageLedger(':memory:') } = {}) {
  const calls = [];
  const waits = [];
  let next = 0;
  const port = createModelBackendPort({
    readConfig: () => readModelBackendConfig('model-backends.json', { read: () => raw ?? config(roles, connections) }),
    secrets: { read: async ref => keys[ref] ?? null },
    ledger,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const response = responses[next++];
      if (!response) throw new Error('No fake response queued');
      return typeof response === 'function' ? response() : response;
    },
    wait: async ms => { waits.push(ms); },
    now: () => NOW
  });
  return { port, calls, waits, ledger };
}

const usageFor = (port, roleId) => port.usage({ role: roleId }).groups;

test('C1: only the configured role calls its model; other roles stay with the current session', async () => {
  const { port, calls } = harness({ bole: role('local') }, { responses: [openAiStream(answer())] });

  const jefa = await port.decide(request({ role: 'jefa' }));
  assert.equal(jefa.envelope, null);
  assert.equal(jefa.modelReceipt.status, 'not_configured');
  assert.equal(jefa.modelReceipt.reason, 'role_not_configured');
  assert.equal(jefa.modelReceipt.fallbackEligible, false);
  assert.equal(calls.length, 0);

  const bole = await port.decide(request());
  assert.equal(bole.modelReceipt.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].body.model, 'qwen-test');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.deepEqual(bole.envelope, {
    role: 'bole', operation: 'pick', requestId: 'req-1', sourceEventId: 'event-1',
    scope: { personalSpaceId: 'space', personalProjectId: 'alpha', sessionRef: 'codex:thread-1' },
    evidence: { refs: ['e1'], evidenceVersion: 'ev-1', policyVersion: 'pol-1' },
    decision: 'propose', payload: { choice: 'ada' }, reason: 'Ada has recent review evidence.', uncertainty: null,
    execution: { status: 'pending' }
  });
  assert.equal(bole.modelReceipt.actualModel, 'qwen-test-actual');
  assert.equal(bole.modelReceipt.requestedModel, 'qwen-test');
  assert.equal(bole.modelReceipt.outputMode, 'json_schema');
  assert.deepEqual(bole.modelReceipt.usage, { inputTokens: 50, outputTokens: 10, totalTokens: 60, unknownAttempts: 0 });
  assert.deepEqual(usageFor(port, 'jefa'), []);
  assert.equal(usageFor(port, 'bole')[0].requests, 1);
});

test('a missing file, a missing roles section, a disabled role and an unlisted operation are not configured', async () => {
  const absent = createModelBackendPort({ readConfig: () => readModelBackendConfig('none.json', { read: () => null }),
    secrets: { read: async () => null }, ledger: new ModelUsageLedger(':memory:'),
    fetchImpl: async () => { throw new Error('no call'); } });
  assert.equal((await absent.decide(request())).modelReceipt.reason, 'no_config');

  const noRoles = harness(undefined, { raw: { version: 1, connections: config({}).connections } });
  assert.equal((await noRoles.port.decide(request())).modelReceipt.reason, 'role_not_configured');

  const disabled = harness({ bole: role('local', { enabled: false }) });
  assert.equal((await disabled.port.decide(request())).modelReceipt.reason, 'role_disabled');

  const unlisted = harness({ bole: role('local') });
  const result = await unlisted.port.decide(request({ operation: 'hire' }));
  assert.equal(result.modelReceipt.status, 'not_configured');
  assert.equal(result.modelReceipt.reason, 'operation_not_allowed');
  assert.equal(unlisted.calls.length, 0);
});

test('C2: transient failures retry once with backoff, then report fallback eligibility with every attempt recorded', async () => {
  const failing = () => sse([
    { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-test-actual', usage: { input_tokens: 120, output_tokens: 1 } } } },
    { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }
  ]);
  const { port, calls, waits } = harness({ tonborg: role('claude') }, {
    responses: [failing, json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '2' })]
  });
  const result = await port.decide(request({ role: 'tonborg' }));
  assert.equal(result.envelope, null);
  assert.equal(result.modelReceipt.status, 'failed');
  assert.equal(result.modelReceipt.failureClass, 'transient');
  assert.equal(result.modelReceipt.reason, 'rate_limited');
  assert.equal(result.modelReceipt.fallbackEligible, true);
  assert.equal(result.modelReceipt.fallbackReason, 'rate_limited');
  assert.equal(result.modelReceipt.attempts, 2);
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
  assert.deepEqual(result.modelReceipt.usage, { inputTokens: 120, outputTokens: null, totalTokens: null, unknownAttempts: 2 });

  const [group] = usageFor(port, 'tonborg');
  assert.equal(group.requests, 1);
  assert.equal(group.attempts, 2);
  assert.equal(group.retries, 1);
  assert.equal(group.failedAttempts, 2);
  assert.equal(group.failedRequests, 1);
  assert.deepEqual(group.tokens.input, { reported: 120, unknownAttempts: 1 });
  assert.deepEqual(group.tokens.total, { reported: null, unknownAttempts: 2 });
});

test('C2: a timeout is transient, and without fallback authorization the failure is not fallback eligible', async () => {
  const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const { port, calls } = harness({ bole: role('local', { fallbackToSession: false }) }, { responses: [timeout, timeout] });
  const result = await port.decide(request());
  assert.equal(result.modelReceipt.reason, 'timeout');
  assert.equal(result.modelReceipt.failureClass, 'transient');
  assert.equal(result.modelReceipt.fallbackEligible, false);
  assert.equal(result.modelReceipt.fallbackReason, null);
  assert.equal(calls.length, 2);
});

test('C3: an invalid model ID is a repairable configuration error and is not retried', async () => {
  const { port, calls } = harness({ bole: role('local') }, {
    responses: [json(404, { error: { message: 'model "qwen-test" not found, try pulling it first', type: 'api_error' } })]
  });
  const result = await port.decide(request());
  assert.equal(result.modelReceipt.status, 'failed');
  assert.equal(result.modelReceipt.failureClass, 'configuration');
  assert.equal(result.modelReceipt.reason, 'model_or_endpoint_not_found');
  assert.equal(result.modelReceipt.fallbackEligible, true);
  assert.equal(calls.length, 1);

  // The error body shape Jev returned for an unknown model in the live check.
  const jev = harness({ tonborg: role('jev') }, {
    responses: [json(400, { detail: { error_type: 'api_usage_error', message: 'Unknown model: jev-0.0.0-missing' } })]
  });
  assert.equal((await jev.port.decide(request({ role: 'tonborg' }))).modelReceipt.reason, 'model_or_endpoint_not_found');
});

test('C3: a missing key fails before any request, and a provider echo of the key never leaks', async () => {
  const missing = harness({ tonborg: role('claude') }, { keys: {} });
  const result = await missing.port.decide(request({ role: 'tonborg' }));
  assert.equal(result.modelReceipt.failureClass, 'configuration');
  assert.equal(result.modelReceipt.reason, 'missing_key');
  assert.equal(missing.calls.length, 0);

  const key = KEYS['anthropic-main'];
  const echo = harness({ tonborg: role('claude') }, {
    responses: [json(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${key}` } })]
  });
  const rejected = await echo.port.decide(request({ role: 'tonborg' }));
  assert.equal(rejected.modelReceipt.reason, 'auth_failed');
  assert.equal(rejected.modelReceipt.failureClass, 'configuration');
  assert.equal(echo.calls[0].headers['x-api-key'], key);
  assert.equal(echo.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(JSON.stringify(rejected).includes(key), false);
  assert.equal(JSON.stringify(echo.port.usage({})).includes(key), false);
  assert.equal(JSON.stringify(echo.ledger.db.prepare('SELECT * FROM model_attempts').all()).includes(key), false);
});

test('C3: an invalid configuration is a repairable error, never silently treated as not configured', async () => {
  const broken = config({ bole: role('local') });
  broken.connections.local.protocol = 'smoke_signals';
  const { port, calls } = harness(undefined, { raw: broken });
  const result = await port.decide(request());
  assert.equal(result.modelReceipt.status, 'failed');
  assert.equal(result.modelReceipt.failureClass, 'configuration');
  assert.equal(result.modelReceipt.reason, 'invalid_config');
  assert.equal(result.modelReceipt.fallbackEligible, false);
  assert.equal(calls.length, 0);
});

test('C4: a permission 403 and a model refusal stop the work and are never fallback eligible', async () => {
  const forbidden = harness({ tonborg: role('claude') }, {
    responses: [json(403, { type: 'error', error: { type: 'permission_error', message: 'not allowed' } })]
  });
  const stopped = await forbidden.port.decide(request({ role: 'tonborg' }));
  assert.equal(stopped.modelReceipt.status, 'stopped');
  assert.equal(stopped.modelReceipt.failureClass, 'refusal');
  assert.equal(stopped.modelReceipt.reason, 'permission_denied');
  assert.equal(stopped.modelReceipt.fallbackEligible, false);
  assert.equal(forbidden.calls.length, 1);

  const refusing = harness({ tonborg: role('claude') }, { responses: [anthropicStream('', { stopReason: 'refusal' })] });
  const refused = await refusing.port.decide(request({ role: 'tonborg' }));
  assert.equal(refused.modelReceipt.status, 'stopped');
  assert.equal(refused.modelReceipt.reason, 'model_refusal');
  assert.equal(refused.modelReceipt.fallbackEligible, false);
  assert.equal(refusing.calls.length, 1);
});

test('C4: a 403 that names an invalid key is classified by service semantics as configuration', async () => {
  const { port } = harness({ bole: role('local') }, {
    responses: [json(403, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } })]
  });
  const result = await port.decide(request());
  assert.equal(result.modelReceipt.failureClass, 'configuration');
  assert.equal(result.modelReceipt.reason, 'auth_failed');
});

test('C6: a used-up window pauses the role without switching to another role budget on the same connection', async () => {
  const { port, calls, ledger } = harness({
    bole: role('local'),
    tonborg: role('local', { budget: { ...role('local').budget, maxTokensPerWindow: 500_000 } })
  }, { responses: [openAiStream(answer())] });
  ledger.record(attempt({ role: 'bole', usage: usage({ inputTokens: 99_000, outputTokens: 900 }) }));

  const paused = await port.decide(request());
  assert.equal(paused.modelReceipt.status, 'paused');
  assert.equal(paused.modelReceipt.failureClass, 'budget_exhausted');
  assert.equal(paused.modelReceipt.reason, 'window_tokens');
  assert.equal(paused.modelReceipt.fallbackEligible, false);
  assert.equal(calls.length, 0);

  const other = await port.decide(request({ role: 'tonborg', requestId: 'req-2' }));
  assert.equal(other.modelReceipt.status, 'completed');
  assert.equal(calls.length, 1);
});

test('C6: an attempt with unknown usage counts at its ceiling, a per-call input limit and a cost cap also pause', async () => {
  const unknown = harness({ bole: role('local') });
  unknown.ledger.record(attempt({ role: 'bole', usage: usage({}), budgetCeilingTokens: 99_990 }));
  assert.equal((await unknown.port.decide(request())).modelReceipt.reason, 'window_tokens');

  const small = harness({ bole: role('local', { budget: { ...role('local').budget, maxInputTokens: 20 } }) });
  const tooLarge = await small.port.decide(request());
  assert.equal(tooLarge.modelReceipt.status, 'paused');
  assert.equal(tooLarge.modelReceipt.reason, 'per_call_input');
  assert.equal(small.calls.length, 0);

  const capped = harness({ tonborg: role('claude', { budget: { ...role('claude').budget, maxCostPerWindow: 0.01 } }) });
  capped.ledger.record(attempt({ role: 'tonborg', protocol: 'anthropic_messages', usage: usage({ inputTokens: 1000, outputTokens: 100 }),
    estimatedCost: 0.0099, costCurrency: 'USD' }));
  const costly = await capped.port.decide(request({ role: 'tonborg' }));
  assert.equal(costly.modelReceipt.reason, 'window_cost');
  assert.equal(capped.calls.length, 0);
});

function gate() {
  let open;
  const opened = new Promise(resolve => { open = resolve; });
  return { open, after: response => () => opened.then(() => response) };
}

const windowOf = (ledger, roleId) => ledger.window({ role: roleId, since: '2026-10-19T00:00:00.000Z' });
const ceilings = ledger => ledger.db.prepare('SELECT budget_ceiling_tokens AS ceiling FROM model_attempts ORDER BY attempt_number')
  .all().map(row => row.ceiling);

test('C6: concurrent attempts of one role reserve their ceiling first, so together they never pass the window', async () => {
  const held = gate();
  const shared = { ...role('local').budget, maxTokensPerWindow: 1500 };
  const { port, calls, ledger } = harness({ bole: role('local', { budget: shared }) },
    { responses: [held.after(openAiStream(answer(), { usage: null }))] });

  const first = port.decide(request());
  const second = await port.decide(request({ requestId: 'req-2' }));
  assert.equal(second.modelReceipt.status, 'paused');
  assert.equal(second.modelReceipt.reason, 'window_tokens');
  assert.equal(calls.length, 1);
  const ceiling = windowOf(ledger, 'bole').reservedTokens;
  assert.ok(ceiling > 750 && ceiling <= 1500, `one attempt ceiling ${ceiling} must fit once, not twice`);

  held.open();
  assert.equal((await first).modelReceipt.status, 'completed');
  // Unknown usage settles at the reserved ceiling.
  assert.deepEqual(ceilings(ledger), [ceiling]);
  assert.equal(windowOf(ledger, 'bole').reservedTokens, ceiling);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM model_reservations').get().n, 0);
});

test('C6: concurrent priced attempts reserve their cost ceiling against the cost cap', async () => {
  const held = gate();
  const capped = { ...role('claude').budget, maxCostPerWindow: 0.015 };
  const { port, calls, ledger } = harness({ tonborg: role('claude', { budget: capped }) },
    { responses: [held.after(anthropicStream(answer()))] });

  const first = port.decide(request({ role: 'tonborg' }));
  await new Promise(setImmediate);
  const second = await port.decide(request({ role: 'tonborg', requestId: 'req-2' }));
  assert.equal(second.modelReceipt.reason, 'window_cost');
  assert.equal(calls.length, 1);
  assert.ok(windowOf(ledger, 'tonborg').estimatedCost > 0.0075, 'the in-flight attempt holds its cost ceiling');

  held.open();
  assert.equal((await first).modelReceipt.status, 'completed');
  assert.equal(windowOf(ledger, 'tonborg').estimatedCost, 0.00064);
});

test('C6: two ports sharing one ledger file see the in-flight reservations of each other', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-ledger-'));
  const ledgers = [new ModelUsageLedger(join(dir, 'usage.sqlite')), new ModelUsageLedger(join(dir, 'usage.sqlite'))];
  t.after(() => { ledgers.forEach(ledger => ledger.close()); rmSync(dir, { recursive: true, force: true }); });
  const held = gate();
  const shared = { ...role('local').budget, maxTokensPerWindow: 1500 };
  const one = harness({ bole: role('local', { budget: shared }) }, { ledger: ledgers[0], responses: [held.after(openAiStream(answer()))] });
  const two = harness({ bole: role('local', { budget: shared }) }, { ledger: ledgers[1], responses: [openAiStream(answer())] });

  const first = one.port.decide(request());
  const second = await two.port.decide(request({ requestId: 'req-2' }));
  assert.equal(second.modelReceipt.reason, 'window_tokens');
  assert.equal(two.calls.length, 0);
  held.open();
  assert.equal((await first).modelReceipt.status, 'completed');
});

test('C6: a reservation left by a crashed process keeps counting at its ceiling and is reclaimed only after it expires', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-ledger-'));
  const path = join(dir, 'usage.sqlite');
  const ledger = new ModelUsageLedger(path);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  // Another process reserves an attempt and exits without settling it.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { ModelUsageLedger } = await import(${JSON.stringify(new URL('../src/model-backends/usage-ledger.js', import.meta.url).href)});
    const ledger = new ModelUsageLedger(${JSON.stringify(path)});
    const pending = ${JSON.stringify(pendingAttempt({ requestId: 'crashed', budgetCeilingTokens: 1200 }))};
    const blocked = ledger.reserve({ attempt: pending, ceilingCost: null, expiresAt: '2026-10-20T12:01:00.000Z',
      since: '2026-10-19T12:00:00.000Z', now: '2026-10-20T11:59:00.000Z', check: () => null });
    process.exit(blocked ? 2 : 0);`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);

  const shared = { ...role('local').budget, maxTokensPerWindow: 1500 };
  const { port, calls } = harness({ bole: role('local', { budget: shared }) }, { ledger, responses: [openAiStream(answer())] });
  const paused = await port.decide(request());
  assert.equal(paused.modelReceipt.reason, 'window_tokens');
  assert.equal(calls.length, 0);
  assert.equal(windowOf(ledger, 'bole').reservedTokens, 1200);

  // Expired: it becomes an attempt with unknown usage and still counts at its ceiling.
  const later = createModelBackendPort({ readConfig: () => readModelBackendConfig('m.json', { read: () => config({ bole: role('local', { budget: shared }) }) }),
    secrets: { read: async () => null }, ledger, fetchImpl: async () => openAiStream(answer()),
    now: () => new Date('2026-10-20T12:05:00.000Z') });
  assert.equal((await later.decide(request({ requestId: 'req-3' }))).modelReceipt.reason, 'window_tokens');
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM model_reservations').get().n, 0);
  const reclaimed = ledger.db.prepare("SELECT * FROM model_attempts WHERE request_id = 'crashed'").get();
  assert.equal(reclaimed.outcome, 'failed');
  assert.equal(reclaimed.failure_reason, 'unsettled');
  assert.equal(reclaimed.total_tokens, null);
  assert.equal(reclaimed.budget_ceiling_tokens, 1200);
});

test('C6: a repair turn is re-estimated, and one that grows past the per-call input limit is not sent', async () => {
  const invalid = `{"decision": "propose", "reason": "${'x'.repeat(1800)}`;
  const probe = harness({ bole: role('local') }, { responses: [openAiStream(invalid), openAiStream(answer())] });
  assert.equal((await probe.port.decide(request())).modelReceipt.status, 'completed');
  const [initialCeiling, repairCeiling] = ceilings(probe.ledger);
  assert.ok(repairCeiling > initialCeiling + 500, 'the repair attempt carries its own, larger ceiling');

  const initialInput = initialCeiling - role('local').budget.maxOutputTokens;
  const tight = { ...role('local').budget, maxInputTokens: initialInput + 10 };
  const { port, calls } = harness({ bole: role('local', { budget: tight }) }, { responses: [openAiStream(invalid), openAiStream(answer())] });
  const result = await port.decide(request());
  assert.equal(result.modelReceipt.status, 'paused');
  assert.equal(result.modelReceipt.reason, 'per_call_input');
  assert.equal(result.modelReceipt.attempts, 1);
  assert.equal(calls.length, 1);
});

test('C6: a format fallback is re-estimated with the schema it writes into the prompt', async () => {
  const unsupported = () => json(400, { error: { message: "response_format type 'json_schema' is not supported", type: 'invalid_request_error' } });
  const probe = harness({ bole: role('local') }, { responses: [unsupported(), openAiStream(answer())] });
  await probe.port.decide(request());
  const [initialCeiling, fallbackCeiling] = ceilings(probe.ledger);
  assert.ok(fallbackCeiling > initialCeiling, 'the prompt-mode attempt carries its own, larger ceiling');

  const initialInput = initialCeiling - role('local').budget.maxOutputTokens;
  const tight = { ...role('local').budget, maxInputTokens: initialInput };
  const { port, calls } = harness({ bole: role('local', { budget: tight }) }, { responses: [unsupported(), openAiStream(answer())] });
  const result = await port.decide(request());
  assert.equal(result.modelReceipt.reason, 'per_call_input');
  assert.equal(calls.length, 1);
});

test('C7: unapproved project or unassigned content is blocked before any request is built', async () => {
  for (const blocked of [
    request({ evidence: [{ id: 'e9', personalProjectId: 'beta', text: 'Beta private plan.' }] }),
    request({ evidence: [{ id: 'e9', personalProjectId: null, text: 'Temporary note.' }] }),
    request({ scope: { personalSpaceId: 'space', personalProjectId: 'beta', sessionRef: null }, evidence: [] }),
    request({ scope: { personalSpaceId: 'other', personalProjectId: 'alpha', sessionRef: null } })
  ]) {
    const { port, calls, ledger } = harness({ bole: role('local') });
    const result = await port.decide(blocked);
    assert.equal(result.modelReceipt.status, 'stopped');
    assert.equal(result.modelReceipt.failureClass, 'refusal');
    assert.equal(result.modelReceipt.reason, 'egress_not_approved');
    assert.equal(result.modelReceipt.fallbackEligible, false);
    assert.equal(calls.length, 0);
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM model_attempts').get().n, 0);
  }
  const unassigned = harness({ bole: role('local', { egress: { approvedProjects: [], allowUnassigned: true } }) },
    { responses: [openAiStream(answer({ evidenceIds: ['e9'] }))] });
  const allowed = await unassigned.port.decide(request({ scope: { personalSpaceId: 'space', personalProjectId: null, sessionRef: null },
    evidence: [{ id: 'e9', personalProjectId: null, text: 'Temporary note.' }] }));
  assert.equal(allowed.modelReceipt.status, 'completed');
});

test('C8: broken JSON gets exactly one repair attempt and a second invalid reply is never acted on', async () => {
  const repaired = harness({ bole: role('local') }, { responses: [openAiStream('{"decision": "propose", '), openAiStream(answer())] });
  const ok = await repaired.port.decide(request());
  assert.equal(ok.modelReceipt.status, 'completed');
  assert.equal(ok.modelReceipt.attempts, 2);
  const repairTurn = repaired.calls[1].body.messages.at(-1);
  assert.equal(repairTurn.role, 'user');
  assert.match(repairTurn.content, /not valid/);
  assert.equal(usageFor(repaired.port, 'bole')[0].repairs, 1);

  for (const invalid of [
    '{"decision": "propose", ',
    answer({ payload: { choice: 'zed' } }),
    JSON.stringify({ decision: 'propose' }),
    answer({ evidenceIds: ['e404'] }),
    answer({ decision: 'apply_authorized' }),
    answer({ extra: 'field' })
  ]) {
    const { port, calls } = harness({ bole: role('local') }, { responses: [openAiStream(invalid), openAiStream(invalid)] });
    const result = await port.decide(request());
    assert.equal(result.envelope, null, invalid);
    assert.equal(result.modelReceipt.status, 'failed');
    assert.equal(result.modelReceipt.failureClass, 'configuration');
    assert.equal(result.modelReceipt.reason, 'invalid_output');
    assert.equal(calls.length, 2, invalid);
  }
});

test('an endpoint that rejects json_schema falls back to prompt mode once and remembers it', async () => {
  const { port, calls } = harness({ bole: role('local') }, { responses: [
    json(400, { error: { message: "response_format type 'json_schema' is not supported", type: 'invalid_request_error' } }),
    openAiStream(answer()), openAiStream(answer())
  ] });
  const first = await port.decide(request());
  assert.equal(first.modelReceipt.status, 'completed');
  assert.equal(first.modelReceipt.outputMode, 'prompt');
  assert.equal(first.modelReceipt.attempts, 2);
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.equal(calls[1].body.response_format, undefined);
  assert.match(calls[1].body.messages[0].content, /JSON schema/);

  await port.decide(request({ requestId: 'req-2' }));
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.response_format, undefined);
});

test('C12: unreported usage stays unknown and cost appears only as a configured-price estimate', async () => {
  const unreported = harness({ bole: role('local') }, { responses: [openAiStream(answer(), { usage: null })] });
  const result = await unreported.port.decide(request());
  assert.equal(result.modelReceipt.status, 'completed');
  assert.deepEqual(result.modelReceipt.usage, { inputTokens: null, outputTokens: null, totalTokens: null, unknownAttempts: 1 });
  const [group] = usageFor(unreported.port, 'bole');
  assert.deepEqual(group.tokens.total, { reported: null, unknownAttempts: 1 });
  assert.equal(group.estimatedCost, null);

  const priced = harness({ tonborg: role('claude') }, { responses: [anthropicStream(answer())] });
  await priced.port.decide(request({ role: 'tonborg' }));
  const [claude] = usageFor(priced.port, 'tonborg');
  assert.deepEqual(claude.estimatedCost, { amount: 0.00064, currency: 'USD', basis: 'estimate', unknownAttempts: 0 });
});

test('streamed usage is read at the end, cumulative deltas are not double counted, subsets stay subsets', async () => {
  const { port } = harness({ tonborg: role('claude'), bole: role('local') }, { responses: [
    anthropicStream(answer(), { start: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 },
      deltas: [{ output_tokens: 10 }, { output_tokens: 15 }] }),
    openAiStream(answer(), { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60,
      prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 4 } } })
  ] });
  const claude = await port.decide(request({ role: 'tonborg' }));
  assert.deepEqual(claude.modelReceipt.usage, { inputTokens: 125, outputTokens: 15, totalTokens: 140, unknownAttempts: 0 });
  const [anthropic] = usageFor(port, 'tonborg');
  assert.deepEqual(anthropic.tokens.cachedInput, { reported: 20, unknownAttempts: 0 });
  assert.deepEqual(anthropic.tokens.cacheWriteInput, { reported: 5, unknownAttempts: 0 });
  assert.equal(anthropic.tokens.reasoning, undefined);

  await port.decide(request({ requestId: 'req-2' }));
  const [openai] = usageFor(port, 'bole');
  assert.deepEqual(openai.tokens.input, { reported: 50, unknownAttempts: 0 });
  assert.deepEqual(openai.tokens.total, { reported: 60, unknownAttempts: 0 });
  assert.deepEqual(openai.tokens.cachedInput, { reported: 30, unknownAttempts: 0 });
  assert.deepEqual(openai.tokens.reasoning, { reported: 4, unknownAttempts: 0 });
});

test('Jev answers bounded Choice and Score questions and refuses structured planning', async () => {
  const { port, calls } = harness({ tonborg: role('jev') }, { responses: [
    json(200, { model: 'jev-1.13.0', answers: { answer: { type: 'choice', choice: 'ada',
      probabilities: { ada: 0.91, bo: 0.09 }, confidence: 0.82 } }, usage: { input_tokens: 140, output_tokens: 0 } }),
    json(200, { model: 'jev-1.13.0', answers: { answer: { type: 'score', score: 1.4,
      legend: { 0: 'low', 1: 'mid', 2: 'high' }, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 }, confidence: 0.6 } }, usage: { input_tokens: 90, output_tokens: 0 } })
  ] });
  const choice = await port.decide(request({ role: 'tonborg' }));
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].headers.authorization, `Bearer ${KEYS['jev-main']}`);
  assert.deepEqual(calls[0].body.questions, { answer: { type: 'choice',
    instructions: 'Which Agent should take the next review?', criteria: { ada: 'Ada, reviewer', bo: 'Bo, writer' } } });
  assert.deepEqual(calls[0].body.state, { evidence: [{ id: 'e1', text: 'Ada finished three reviews this week.' }] });
  assert.equal(choice.modelReceipt.outputMode, 'typed');
  assert.equal(choice.modelReceipt.reportedConfidence, 0.82);
  assert.deepEqual(choice.envelope.payload, { choice: 'ada' });
  assert.equal(choice.envelope.decision, 'propose');
  assert.equal(choice.envelope.reason, null);
  assert.deepEqual(choice.modelReceipt.usage, { inputTokens: 140, outputTokens: 0, totalTokens: 140, unknownAttempts: 0 });

  const score = await port.decide(request({ role: 'tonborg', requestId: 'req-2', output: { type: 'score', levels: ['low', 'mid', 'high'] } }));
  assert.deepEqual(calls[1].body.questions.answer, { type: 'score', instructions: 'Which Agent should take the next review?',
    criteria: ['low', 'mid', 'high'] });
  assert.deepEqual(score.envelope.payload, { score: 1.4 });

  const structured = await port.decide(request({ role: 'tonborg', requestId: 'req-3', operation: 'plan', output: { type: 'structured',
    schema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'], additionalProperties: false } } }));
  assert.equal(structured.modelReceipt.failureClass, 'configuration');
  assert.equal(structured.modelReceipt.reason, 'unsupported_output');
  assert.equal(calls.length, 2);
});

test('structured payloads are validated strictly against the caller schema', async () => {
  const schema = { type: 'object', properties: { steps: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 3 } },
    required: ['steps'], additionalProperties: false };
  const { port, calls } = harness({ jefa: role('quiet') }, { connections: { quiet: { protocol: 'openai_chat',
    endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: null, reasoningEffort: 'none' } }, responses: [
    openAiStream(answer({ payload: { steps: ['a', 'b', 'c', 'd'] } })),
    openAiStream(answer({ payload: { steps: ['Draft', 'Review'] } }))
  ] });
  const result = await port.decide(request({ role: 'jefa', operation: 'plan', output: { type: 'structured', schema } }));
  assert.equal(result.modelReceipt.status, 'completed');
  assert.deepEqual(result.envelope.payload, { steps: ['Draft', 'Review'] });
  const sent = calls[0].body.response_format.json_schema;
  assert.equal(sent.strict, true);
  assert.equal(calls[0].body.reasoning_effort, 'none');
  assert.equal(sent.schema.properties.payload.properties.steps.maxItems, undefined);
  assert.equal(sent.schema.additionalProperties, false);
});

test('the connection check sends only fixed synthetic text, also for a role that lists no such operation', async () => {
  const ready = JSON.stringify({ decision: 'propose', payload: { choice: 'ready' }, reason: 'Ready.', evidenceIds: [], uncertainty: null });
  const { port, calls } = harness({ bole: role('local', { allowedOperations: ['pick'],
    egress: { approvedProjects: [], allowUnassigned: false } }) }, { responses: [openAiStream(ready)] });
  const result = await port.checkConnection('bole');
  assert.equal(result.modelReceipt.status, 'completed');
  assert.equal(result.envelope.operation, 'connection_check');
  assert.deepEqual(result.envelope.payload, { choice: 'ready' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].body).includes('alpha'), false);
  assert.equal((await port.checkConnection('jefa')).modelReceipt.status, 'not_configured');
  assert.equal(port.usage({ role: 'bole' }).groups[0].requests, 1);
});

test('invalid caller input is a programming error, not a model failure', async () => {
  const { port } = harness({ bole: role('local') });
  await assert.rejects(port.decide(request({ role: 'astro' })), TypeError);
  await assert.rejects(port.decide(request({ evidence: [{ id: 'e1', personalProjectId: 'alpha', text: 'a' },
    { id: 'e1', personalProjectId: 'alpha', text: 'b' }] })), TypeError);
  await assert.rejects(port.decide(request({ output: { type: 'structured', schema: { type: 'object',
    properties: { a: { type: 'string' } }, additionalProperties: false } } })), /required/);
});

function usage({ inputTokens = null, outputTokens = null }) {
  return { inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, definition: 'openai_chat' };
}

function attempt(overrides) {
  return {
    requestId: `seed-${Math.random()}`, attemptId: 'a1', attemptNumber: 1, purpose: 'initial', channel: 'model_api',
    role: 'bole', operation: 'pick', personalSpaceId: 'space', personalProjectId: 'alpha', connectionId: 'local',
    protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', requestedModel: 'qwen-test', actualModel: 'qwen-test',
    outputMode: 'json_schema', startedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), durationMs: 10,
    outcome: 'succeeded', failureClass: null, failureReason: null, usage: usage({}), budgetCeilingTokens: 1000,
    estimatedCost: null, costCurrency: null, ...overrides
  };
}

function pendingAttempt(overrides) {
  const { actualModel, durationMs, outcome, failureClass, failureReason, usage: _usage, estimatedCost, ...pending } = attempt(overrides);
  return pending;
}
