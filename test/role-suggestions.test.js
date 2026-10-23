import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { mapHttpError } from '../src/http/error-mapping.js';
import { handleModelBackendApiRequest } from '../src/model-backends/http.js';
import { noteRoleSuggestion, RoleSuggestionLog } from '../src/model-backends/suggestion-log.js';
import { listenFetchableServer } from '../src/server/listen.js';

// Synthetic suggestions only: no model, no data directory but a temporary one.
const GATE = { status: 'suggestion_only', role: 'jefa', operation: 'board_match' };
const RECEIPT = { requestId: 'board_match:r1', evidenceVersion: 'e'.repeat(64), promptVersion: 'board_match:p1', gate: GATE,
  modelReceipt: { backend: 'model_api', status: 'completed', requestedModel: 'qwen-test', actualModel: 'qwen-test-actual', attempts: 1 } };
const SUGGESTED = { status: 'suggested', hint: '可能是看板上的「Seed inventory」任务', confirmWith: 'call_employee_tool',
  suggestion: { taskId: 'task-seeds', title: 'Seed inventory', reason: 'Same page.', uncertainty: null },
  suggestedBy: { mode: 'model_api', independent: true, model: 'qwen-test-actual' }, ...RECEIPT };
const INLINE = { status: 'inline', reason: 'server_error', guidance: 'Match the board yourself as usual.', ...RECEIPT };


test('the log keeps each shown result as the session got it, without the session guidance, newest first', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-role-suggestions-'));
  const path = join(directory, 'role-suggestions.sqlite');
  let now = Date.parse('2026-10-23T08:00:00.000Z');
  const log = new RoleSuggestionLog(path, { now: () => new Date(now += 60_000) });
  t.after(() => { log.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(log.list(), []);
  assert.equal(existsSync(path), false, 'reading creates no file');

  log.record({ role: 'jefa', operation: 'board_match', personalSpaceId: 'space-a', personalProjectId: 'garden', result: SUGGESTED });
  log.record({ role: 'jefa', operation: 'board_match', personalSpaceId: 'space-a', personalProjectId: 'garden', result: INLINE });
  const [fallback, suggested] = log.list();
  assert.deepEqual(suggested, { ...SUGGESTED, id: 1, at: '2026-10-23T08:01:00.000Z', role: 'jefa', operation: 'board_match',
    personalSpaceId: 'space-a', personalProjectId: 'garden', subject: {} });
  assert.deepEqual([fallback.status, fallback.reason, 'guidance' in fallback, fallback.gate], ['inline', 'server_error', false, GATE]);
  assert.equal(log.list({ limit: 1 }).length, 1);
});

test('a log that cannot be written never changes the role\'s answer', () => {
  const failing = { roleSuggestions: { record: () => { throw new Error('disk full'); } } };
  assert.doesNotThrow(() => noteRoleSuggestion(failing, { role: 'jefa', result: SUGGESTED }));
  assert.doesNotThrow(() => noteRoleSuggestion({}, { role: 'jefa', result: SUGGESTED }));
});

test('the console reads suggestions over a GET-only route that never writes', async (t) => {
  const log = new RoleSuggestionLog();
  t.after(() => log.close());
  log.record({ role: 'jefa', operation: 'board_match', personalSpaceId: 'space-a', personalProjectId: 'garden', result: SUGGESTED });
  const recorded = log.record.bind(log);
  const writes = [];
  log.record = (entry) => { writes.push(entry); return recorded(entry); };
  const serve = (roleSuggestions) => async (request, response) => {
    try {
      if (!await handleModelBackendApiRequest({ request, response, url: new URL(request.url, 'http://local'),
        modelBackends: { roles: () => ({}) }, roleSuggestions })) response.writeHead(404).end();
    } catch (error) {
      const mapped = mapHttpError(error);
      response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body));
    }
  };
  const server = createServer(serve(log));
  const bare = createServer(serve(null));
  await listenFetchableServer(server, 0);
  await listenFetchableServer(bare, 0);
  const url = (target) => `http://127.0.0.1:${target.address().port}/api/model-backends/suggestions`;
  try {
    const ok = await fetch(url(server));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const { suggestions } = await ok.json();
    assert.deepEqual(suggestions.map(entry => [entry.role, entry.status, entry.suggestion.taskId, entry.gate.status]),
      [['jefa', 'suggested', 'task-seeds', 'suggestion_only']]);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(url(server), { method, body: method === 'DELETE' ? undefined : '{}' })).status, 405, method);
    }
    assert.deepEqual(writes, []);
    assert.equal(log.list().length, 1);
    assert.equal((await fetch(url(bare))).status, 503);
  } finally {
    server.close();
    bare.close();
  }
});
