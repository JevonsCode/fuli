import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ApplicationError, InvalidInputError } from '../src/app/application-error.js';
import { runCodexLifecycleCommand } from '../src/agents/codex/lifecycle-hook.js';
import { runOpenCodeLifecycleCommand } from '../src/agents/opencode/lifecycle-hook.js';
import { formatDiagnostics, runDiagnosticsCommand } from '../src/cli/diagnostics-command.js';
import { inspectLocalStores } from '../src/data-format/local-stores.js';
import { DIAGNOSTIC_HANDLERS } from '../src/diagnostics/agent-tool.js';
import { diagnosticEventLog } from '../src/diagnostics/event-log.js';
import { recordHttpFailure, recordToolFailure } from '../src/diagnostics/failure-records.js';
import { diagnosticEventsAnswer, MAX_DIAGNOSTIC_LIMIT } from '../src/diagnostics/query.js';
import { handleDiagnosticEventsRequest } from '../src/http/diagnostic-events-api-router.js';

// Synthetic secrets only; none of these is a real credential.
const SECRETS = Object.freeze({
  apiKey: 'sk-SYNTHETICabcdefghijklmnopqrstuvwx',
  bearer: 'Bearer SYNTHETICbearerTokenValue0123456789',
  taskToken: 'fuliSYNTHETICtaskToken0123456789abcdefABCDEF',
  password: 'password=SyntheticPass123!',
  query: 'https://user:hunter2@example.test/api/search?q=private-topic&token=abc123',
  path: '/home/synthetic-user/projects/secret-plan/notes.md'
});

async function dataDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

function lines(directory, file = 'events.jsonl') {
  return readFile(join(directory, 'diagnostics', file), 'utf8')
    .then((text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

const failure = (overrides = {}) => ({ component: 'http', operation: 'GET /api/synthetic', outcome: 'failed',
  code: 'synthetic_failure', reason: 'synthetic reason', ...overrides });

test('the diagnostics log appends one safe event per line with its time zone, version and correlation', async (t) => {
  const directory = await dataDir(t);
  const log = diagnosticEventLog(directory, { now: () => new Date('2026-11-05T06:00:00.000Z') });
  assert.equal(log.record(failure({ durationMs: 12, correlationId: 'synthetic-session-1' })), true);
  assert.equal(log.record(failure({ component: 'mcp', outcome: 'refused', durationMs: -1, correlationId: 'has space' })), true);
  const [first, second] = await lines(directory);
  assert.equal(first.v, 1);
  assert.match(first.at, /^2026-11-0\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  assert.equal(Date.parse(first.at), Date.parse('2026-11-05T06:00:00.000Z'));
  assert.equal(typeof first.version, 'string');
  assert.deepEqual([first.component, first.outcome, first.level, first.code, first.durationMs, first.correlationId],
    ['http', 'failed', 'error', 'synthetic_failure', 12, 'synthetic-session-1']);
  assert.equal(second.level, 'warning');
  assert.equal('durationMs' in second, false, 'an impossible duration is left out');
  assert.equal('correlationId' in second, false, 'an unsafe correlation id is left out');
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'diagnostics', 'events.jsonl'))).mode & 0o777, 0o600);
});

test('recording never throws and creates nothing outside an existing data directory', async (t) => {
  const parent = await dataDir(t);
  const missing = join(parent, 'not-created');
  assert.equal(diagnosticEventLog(missing).record(failure()), false);
  assert.deepEqual(await readdir(parent), []);
  assert.equal(diagnosticEventLog(parent).record({ component: 'unknown', operation: 'x', outcome: 'failed' }), false);
  assert.equal(diagnosticEventLog(parent).record(null), false);
  // A file where the diagnostics directory belongs makes every append fail quietly.
  await writeFile(join(parent, 'diagnostics'), 'not a directory');
  assert.equal(diagnosticEventLog(parent).record(failure()), false);
});

test('the log rotates past 1 MB, keeps three copies and stops at its hard cap while rotation is blocked', async (t) => {
  const directory = await dataDir(t);
  const log = diagnosticEventLog(directory);
  const reason = 'synthetic failure text '.repeat(9);
  for (let index = 0; index < 13_000; index += 1) log.record(failure({ reason: `${reason} ${index}` }));
  const names = (await readdir(join(directory, 'diagnostics'))).filter((name) => name.startsWith('events')).sort();
  assert.deepEqual(names, ['events.jsonl', 'events.jsonl.1', 'events.jsonl.2', 'events.jsonl.3']);
  for (const name of names) assert.ok((await stat(join(directory, 'diagnostics', name))).size <= 1.25 * 1024 * 1024);
  const answer = diagnosticEventsAnswer(log, { limit: 1 });
  assert.equal(answer.truncated, true);
  assert.deepEqual(answer.truncatedBy, ['page', 'retention']);
  assert.ok(answer.total < 13_000, 'rotation dropped the oldest events');

  const blocked = await dataDir(t);
  const stuck = diagnosticEventLog(blocked, { lock: () => { throw new Error('synthetic lock held'); } });
  let refused = 0;
  for (let index = 0; index < 6_000 && refused === 0; index += 1) {
    if (!stuck.record(failure({ reason: `${reason} ${index}` }))) refused += 1;
  }
  assert.equal(refused, 1, 'a file at its hard cap takes no more events');
  assert.ok((await stat(join(blocked, 'diagnostics', 'events.jsonl'))).size <= 1.25 * 1024 * 1024);
});

test('stored text never carries a synthetic secret, task token, URL query value or local path', async (t) => {
  const directory = await dataDir(t);
  const log = diagnosticEventLog(directory);
  const reason = Object.values(SECRETS).join(' \n ');
  log.record(failure({ operation: `GET ${SECRETS.query}`, reason, correlationId: SECRETS.bearer }));
  const text = await readFile(join(directory, 'diagnostics', 'events.jsonl'), 'utf8');
  for (const value of ['sk-SYNTHETIC', 'SYNTHETICbearerTokenValue', 'fuliSYNTHETICtaskToken', 'SyntheticPass123',
    'hunter2', 'private-topic', 'abc123', 'synthetic-user', 'secret-plan']) {
    assert.equal(text.includes(value), false, `${value} must not be stored`);
  }
  const [event] = await lines(directory);
  assert.equal(event.reason.includes('\n'), false);
  assert.match(event.operation, /example\.test\/api\/search\?q=…&token=…/);
  assert.match(event.reason, /\[path\]/);
  log.record(failure({ reason: 'C:\\Users\\synthetic\\AppData\\Local\\Fuli\\x.json failed' }));
  log.record(failure({ reason: `id ${'a'.repeat(40)}` }));
  assert.deepEqual((await lines(directory)).slice(1).map(({ reason }) => reason), ['[path] failed', 'id [redacted:opaque]']);
});

test('only a controlled error\'s message reaches the HTTP and MCP writers; any other message never does', async (t) => {
  const directory = await dataDir(t);
  const log = diagnosticEventLog(directory);
  const startedAt = Date.now();
  recordHttpFailure(log, { request: { method: 'POST', url: `/api/synthetic?token=${SECRETS.taskToken}` },
    error: new Error(`raw failure ${SECRETS.apiKey}`), status: 500, startedAt });
  recordHttpFailure(log, { request: { method: 'GET', url: '/api/synthetic' },
    error: new InvalidInputError('limit must be a whole number'), status: 400, startedAt });
  recordToolFailure(log, { toolName: 'search_knowledge_graph', error: new TypeError(`raw ${SECRETS.password}`),
    sessionId: 'synthetic-session', startedAt });
  recordToolFailure(log, { toolName: 'read_diagnostic_events',
    error: new ApplicationError('not_found', 'No such synthetic record', { status: 404 }), startedAt });
  assert.equal(recordToolFailure(null, { toolName: 'x', error: new Error('x'), startedAt }), false);
  const events = await lines(directory);
  assert.deepEqual(events.map(({ component, operation, outcome, code }) => [component, operation, outcome, code]), [
    ['http', 'POST /api/synthetic', 'failed', 'Error'],
    ['http', 'GET /api/synthetic', 'refused', 'invalid_input'],
    ['mcp', 'search_knowledge_graph', 'failed', 'internal_error'],
    ['mcp', 'read_diagnostic_events', 'refused', 'not_found']
  ]);
  assert.deepEqual(events.map(({ reason }) => reason), ['HTTP 500: internal error',
    'HTTP 400: limit must be a whole number', 'Tool execution failed', 'No such synthetic record']);
  assert.equal(events[2].correlationId, 'synthetic-session');
  const text = JSON.stringify(events);
  assert.equal(text.includes('SYNTHETIC') || text.includes('SyntheticPass'), false);
});

test('the query filters, pages by cursor, counts every match and rejects input it cannot use', async (t) => {
  const directory = await dataDir(t);
  let clock = Date.parse('2026-11-05T00:00:00.000Z');
  const log = diagnosticEventLog(directory, { now: () => new Date(clock += 1000) });
  for (let index = 0; index < 7; index += 1) {
    log.record(failure({ component: index % 2 ? 'mcp' : 'hook', outcome: index < 5 ? 'failed' : 'refused',
      code: index % 3 ? 'code_a' : 'code_b' }));
  }
  const all = diagnosticEventsAnswer(log);
  assert.equal(all.total, 7);
  assert.equal(all.stored, true);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.sourcesUnavailable, []);
  assert.deepEqual(all.counts.component, { hook: 4, mcp: 3 });
  assert.deepEqual(all.counts.level, { error: 5, warning: 2 });
  assert.deepEqual(all.counts.code, { code_a: 4, code_b: 3 });
  assert.ok(all.events.every((event, index, events) => index === 0 || event.at <= events[index - 1].at), 'newest first');
  assert.match(all.notCovered, /hard power loss/);

  const seen = [];
  let cursor = null;
  do {
    const page = diagnosticEventsAnswer(log, { limit: '3', ...(cursor ? { cursor } : {}) });
    seen.push(...page.events.map(({ id }) => id));
    assert.equal(page.truncated, page.nextCursor !== null);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all.events.map(({ id }) => id));

  assert.equal(diagnosticEventsAnswer(log, { component: 'mcp', level: 'error' }).total, 2);
  assert.equal(diagnosticEventsAnswer(log, { code: 'code_b' }).total, 3);
  const window = diagnosticEventsAnswer(log, { from: '2026-11-05T00:00:03.000Z', to: '2026-11-05T00:00:05.000Z' });
  assert.equal(window.total, 3);
  for (const input of [{ limit: MAX_DIAGNOSTIC_LIMIT + 1 }, { limit: 0 }, { component: 'kernel' }, { level: 'info' },
    { code: 'not a code' }, { from: 'yesterday' }, { cursor: '../etc' }]) {
    assert.throws(() => diagnosticEventsAnswer(log, input), InvalidInputError, JSON.stringify(input));
  }
});

test('an empty or unreadable log never reads as healthy', async (t) => {
  const directory = await dataDir(t);
  const empty = diagnosticEventsAnswer(diagnosticEventLog(directory));
  assert.deepEqual([empty.stored, empty.total, empty.truncated], [false, 0, false]);
  assert.match(formatDiagnostics(empty), /No diagnostic events are stored/);
  const log = diagnosticEventLog(directory);
  log.record(failure());
  await writeFile(join(directory, 'diagnostics', 'events.jsonl'), '{"v":99}\nnot json\n', { flag: 'a' });
  const skipped = diagnosticEventsAnswer(log);
  assert.equal(skipped.total, 1);
  assert.equal(skipped.skippedLines, 2);
  if (process.platform !== 'win32') {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'diagnostics', 'events.jsonl.1'));
    const answer = diagnosticEventsAnswer(log);
    assert.deepEqual(answer.sourcesUnavailable.map(({ source }) => source), ['diagnostics/events.jsonl.1']);
  }
});

function fakeExchange({ method = 'GET', path = '/api/diagnostics/events', remoteAddress = '127.0.0.1' } = {}) {
  const response = { headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  return { request: { method, socket: { remoteAddress } }, response, url: new URL(path, 'http://127.0.0.1') };
}

test('GET /api/diagnostics/events answers this computer only, with the filters it was given', async (t) => {
  const directory = await dataDir(t);
  const log = diagnosticEventLog(directory);
  log.record(failure({ component: 'provider', code: 'provider_exited' }));
  log.record(failure({ component: 'mcp' }));

  const other = fakeExchange({ path: '/api/system/diagnostics' });
  assert.equal(await handleDiagnosticEventsRequest({ ...other, diagnosticEvents: log }), false);
  const post = fakeExchange({ method: 'POST' });
  await handleDiagnosticEventsRequest({ ...post, diagnosticEvents: log });
  assert.equal(post.response.status, 405);
  const remote = fakeExchange({ remoteAddress: '192.0.2.10' });
  await handleDiagnosticEventsRequest({ ...remote, diagnosticEvents: log });
  assert.deepEqual([remote.response.status, remote.response.body.code], [403, 'local_user_only']);
  const missing = fakeExchange();
  await handleDiagnosticEventsRequest({ ...missing, diagnosticEvents: null });
  assert.deepEqual([missing.response.status, missing.response.body.code], [503, 'diagnostics_unavailable']);
  const filtered = fakeExchange({ path: '/api/diagnostics/events?component=provider&limit=5' });
  await handleDiagnosticEventsRequest({ ...filtered, diagnosticEvents: log });
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.response.headers['cache-control'], 'no-store');
  assert.deepEqual(filtered.response.body.events.map(({ code }) => code), ['provider_exited']);
  assert.equal(filtered.response.body.total, 1);
});

test('read_diagnostic_events reads the same answer and is refused without a local log', async (t) => {
  const directory = await dataDir(t);
  const log = diagnosticEventLog(directory);
  log.record(failure());
  const answer = DIAGNOSTIC_HANDLERS.read_diagnostic_events({ diagnosticEvents: log }, { component: 'http' });
  assert.equal(answer.total, 1);
  assert.throws(() => DIAGNOSTIC_HANDLERS.read_diagnostic_events({}, {}), { code: 'diagnostics_unavailable' });
});

test('fuli diagnostics reads the data directory without the console', async (t) => {
  const directory = await dataDir(t);
  diagnosticEventLog(directory).record(failure({ code: 'provider_not_ready', component: 'provider', durationMs: 40 }));
  let printed = '';
  const result = await runDiagnosticsCommand(['--data-dir', directory, '--component', 'provider'],
    { env: {}, write: (text) => { printed += text; } });
  assert.equal(result.exitCode, 0);
  assert.match(printed, /1 matching event, newest first/);
  assert.match(printed, /provider_not_ready {2}40 ms/);
  assert.match(printed, /By code: provider_not_ready 1/);
  printed = '';
  await runDiagnosticsCommand(['--data-dir', directory, '--json'], { env: {}, write: (text) => { printed += text; } });
  assert.equal(JSON.parse(printed).total, 1);
  await assert.rejects(runDiagnosticsCommand(['--data-dir', directory, '--level', 'info'], { env: {}, write: () => {} }),
    InvalidInputError);
  await assert.rejects(runDiagnosticsCommand(['--unknown'], { env: {}, write: () => {} }), /Usage: fuli diagnostics/);
});

test('migrate status lists the diagnostics log as absent until a failure is recorded', async (t) => {
  const directory = await dataDir(t);
  const state = () => inspectLocalStores(directory).find(({ label }) => label === 'diagnostics');
  assert.deepEqual([state().kind, state().state], ['jsonl', 'absent']);
  diagnosticEventLog(directory).record(failure());
  assert.equal(state().state, 'current');
});

test('a lifecycle hook that fails records it beside its runtime configuration, after answering', async (t) => {
  const directory = await dataDir(t);
  const runtimeConfigPath = join(directory, 'graph-runtime.json');
  const outage = () => { throw new Error(`synthetic runtime outage ${SECRETS.apiKey}`); };
  let codexOutput = '';
  await runCodexLifecycleCommand(['--event', 'Stop', '--timeout-ms', '2000'], {
    readInput: async () => ({ session_id: 'synthetic-codex-session', hook_event_name: 'Stop', cwd: directory }),
    write: (value) => { codexOutput += value; }, resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: outage
  });
  assert.ok(codexOutput, 'the hook answered its client');
  let openCodeOutput = '';
  await runOpenCodeLifecycleCommand(['--event', 'stop', '--timeout-ms', '2000'], {
    readInput: async () => ({ session_id: 'synthetic-opencode-session' }),
    write: (value) => { openCodeOutput += value; }, resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: outage
  });
  assert.ok(openCodeOutput, 'the hook answered its client');
  const events = await lines(directory);
  assert.deepEqual(events.map(({ component, operation, correlationId }) => [component, operation, correlationId]), [
    ['hook', 'codex.Stop', 'synthetic-codex-session'], ['hook', 'opencode.stop', 'synthetic-opencode-session']]);
  assert.equal(JSON.stringify(events).includes('SYNTHETIC'), false);

  const unresolved = await dataDir(t);
  await runCodexLifecycleCommand(['--event', 'Stop', '--timeout-ms', '2000'], {
    readInput: async () => ({ session_id: 's', cwd: unresolved }), write: () => {},
    resolveRuntimeOptions: () => { throw new Error('synthetic unresolved'); }
  });
  assert.deepEqual(await readdir(unresolved), [], 'nothing is written where no data directory was resolved');
  assert.equal((await lines(directory)).length, 2);
});
