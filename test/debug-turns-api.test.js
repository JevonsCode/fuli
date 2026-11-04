import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { interfaceForRequest } from '../src/agent-tools/interface-catalog.js';
import { buildDebugRecord } from '../src/debug-turns/record.js';
import { debugTurnStore } from '../src/debug-turns/store.js';
import { handleApiRequest } from '../src/http/api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { reachableModules } from '../test-support/module-graph.js';

// Settings › 系统 › 调试记录: GET /api/debug-turns, GET and DELETE
// /api/debug-turns/:id, from this computer only. Synthetic records in a temp directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function api(system, path, { method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  const sent = {};
  const response = { destroyed: false, setHeader() {}, writeHead(status) { sent.status = status; },
    end(text) { sent.body = text ? JSON.parse(text) : null; } };
  try {
    sent.handled = await handleApiRequest({ request: { method, url: path, headers: {}, socket: { remoteAddress } }, response,
      app: { config: { personal: { spaceId: 'space-a' } } }, system });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('debug turn records are listed, read and deleted only from this computer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-debug-turn-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const debugTurns = debugTurnStore(directory);
  const record = buildDebugRecord({ sourceApplication: 'claude_code', sessionId: 'synthetic-session', surface: null,
    prompt: '#debug Synthetic ask.\nsecond line', frames: [{ event: 'UserPromptSubmit', text: '{}' }],
    lastAssistantMessage: 'Synthetic answer.', transcript: { status: 'unavailable' } });
  debugTurns.write(record);
  const system = { debugTurns };

  const list = await api(system, '/api/debug-turns');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { records: [{ id: record.id, createdAt: record.createdAt, sourceApplication: 'claude_code',
    promptLine: '#debug Synthetic ask.', totals: record.totals }] });
  assert.deepEqual((await api(system, `/api/debug-turns/${record.id}`)).body, record);

  for (const [path, method] of [['/api/debug-turns', 'GET'], [`/api/debug-turns/${record.id}`, 'GET'], [`/api/debug-turns/${record.id}`, 'DELETE']]) {
    const refused = await api(system, path, { method, remoteAddress: '192.0.2.10' });
    assert.deepEqual([refused.status, refused.body.code], [403, 'local_user_only'], `${method} ${path}`);
  }
  assert.ok(debugTurns.read(record.id), 'another computer deleted nothing');

  assert.equal((await api(system, '/api/debug-turns', { method: 'DELETE' })).status, 405);
  assert.equal((await api(system, '/api/debug-turns/not-a-record')).status, 404);
  assert.deepEqual((await api(system, `/api/debug-turns/${record.id}`, { method: 'DELETE' })).body, { deleted: record.id });
  assert.equal((await api(system, `/api/debug-turns/${record.id}`)).status, 404);
  assert.deepEqual((await api(system, '/api/debug-turns')).body, { records: [] });
  assert.equal((await api({}, '/api/debug-turns')).body.code, 'debug_turns_unavailable');
});

test('an FLA deletes a record only through the settings permission; no Agent entry reads them', () => {
  const entry = interfaceForRequest('DELETE', '/api/debug-turns/00000000-0000-4000-8000-000000000000');
  assert.deepEqual([entry.access, entry.category], ['agent_delegable', 'settings']);
  // The store module is reachable through the format registry, like every store; the read routes are not.
  const console = [join(ROOT, 'src/http/debug-turns-api-router.js')];
  for (const start of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, start));
    assert.deepEqual(console.filter((file) => modules.has(file)), [], start);
  }
});
