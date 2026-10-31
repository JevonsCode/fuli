import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDiagnosticsBundle } from '../src/system/diagnostics-bundle.js';
import { createRedactor, REDACTION_KINDS } from '../src/system/diagnostics-redaction.js';
import { handleDiagnosticsApiRequest } from '../src/http/diagnostics-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { FULI_VERSION } from '../src/package-metadata.js';
import { reachableModules } from '../test-support/module-graph.js';

// 导出诊断包 with synthetic logs in a temporary data directory and a fake
// doctor; the real FULI data directory is never read.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = 'C:\\Users\\Synthia';
const HOST = { homeDir: HOME, username: 'Synthia', platform: 'win32', release: '10.0.26100', arch: 'x64', nodeVersion: 'v24.0.0' };
const SETTINGS = { lanAccess: false, agentNamingStyle: 'Greek gods', notifications: { needsPersonUrl: 'https://hooks.example/T0/secret-path' } };

function dataDirIn(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-diagnostics-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = {
    dataDir,
    logPath: join(dataDir, 'logs', 'runtime.log'),
    nativePersonalDir: join(dataDir, 'native-runtime', 'personal'),
    nativeWorkspaceDir: join(dataDir, 'native-runtime', 'workspace')
  };
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { paths, write };
}

test('the redactor hides home, user, emails, tokens, keys and URL secrets and counts each kind', () => {
  const redactor = createRedactor({ homeDir: HOME, username: 'Synthia' });
  const text = [
    'opened C:\\Users\\Synthia\\AppData\\Local\\Fuli\\logs and C:/Users/synthia/x and "C:\\\\Users\\\\Synthia\\\\y"',
    'mail synthia.dev@example.com; owner Synthia; not Synthian',
    'Authorization: Bearer abcdEFGH12345678.token',
    'key sk-proj-AAAAbbbbCCCCdddd1234 and ghp_ABCDEFGHIJKLMNOPQRSTUV1234',
    'password=hunter2xyz "api_key": "opensesame" token_usage=12',
    'https://bob:pa55@example.com/path?code=1&state=2 and http://127.0.0.1:2727/settings',
    `digest ${'a1'.repeat(20)} blob ${'Ab9'.repeat(15)} path /native-runtime/neo4j-community-5.26.28/lib`
  ].join('\n');
  const shown = redactor.redact(text);
  for (const secret of ['Synthia;', 'Synthia\\', 'synthia/', 'synthia.dev', 'example.com;', 'abcdEFGH', 'sk-proj', 'ghp_', 'hunter2', 'opensesame', 'pa55', 'code=1', 'a1a1a1', 'Ab9Ab9']) {
    assert.equal(shown.includes(secret), false, secret);
  }
  assert.match(shown, /opened ~\\AppData\\Local\\Fuli\\logs and ~\/x and "~\\\\y"/);
  assert.match(shown, /mail <email>; owner <user>; not Synthian/);
  assert.match(shown, /Bearer <token>/);
  assert.match(shown, /https:\/\/<credentials>@example\.com\/path\?<redacted> and http:\/\/127\.0\.0\.1:2727\/settings/);
  assert.match(shown, /token_usage=12/);
  assert.match(shown, /\/native-runtime\/neo4j-community-5\.26\.28\/lib/);
  assert.deepEqual(redactor.counts(), {
    home_directory: 3, url_credentials: 1, url_query: 1, bearer_token: 1, api_key: 2,
    secret_assignment: 2, email: 1, long_secret: 2, username: 1
  });
  assert.deepEqual(Object.keys(redactor.counts()), REDACTION_KINDS);
});

test('the bundle holds version, host, settings without personal values, the doctor and redacted log tails', async (t) => {
  const { paths, write } = dataDirIn(t);
  const lines = Array.from({ length: 450 }, (_, index) => `line ${index + 1} at ${HOME}\\work owner=Synthia`);
  write(paths.logPath, `${lines.join('\r\n')}\r\n`);
  write(join(paths.nativePersonalDir, 'logs', 'provider.log'), 'provider ready token=abcd1234efgh\n');
  write(join(paths.nativeWorkspaceDir, 'logs', 'neo4j-console.log'), '');
  // Knowledge and transcripts beside the logs are never part of it.
  write(join(paths.dataDir, 'agents', 'MEMORY.md'), 'private memory');
  write(join(paths.nativePersonalDir, 'data', 'transcript.jsonl'), 'private transcript');

  const bundle = await createDiagnosticsBundle({
    paths, host: HOST, installKind: () => 'windows-tray', now: () => new Date('2026-11-01T08:00:00Z'),
    settings: () => ({ configured: SETTINGS, active: { ...SETTINGS, agentNamingStyle: '' } }),
    doctor: async () => ({ overall: 'ok', items: [{ id: 'client:codex', data: { configPath: `${HOME}\\.codex\\config.toml` } }] })
  })();

  assert.equal(bundle.generatedAt, '2026-11-01T08:00:00.000Z');
  assert.deepEqual(bundle.files.map(({ name }) => name),
    ['about.json', 'settings.json', 'doctor.json', 'logs/runtime.log', 'native-runtime/personal/logs/provider.log']);
  const file = (name) => bundle.files.find((entry) => entry.name === name).content;
  assert.deepEqual(JSON.parse(file('about.json')), { fuli: { version: FULI_VERSION, installKind: 'windows-tray' },
    os: { platform: 'win32', release: '10.0.26100', arch: 'x64' }, node: 'v24.0.0' });
  const settings = JSON.parse(file('settings.json'));
  assert.deepEqual(settings.configured, { lanAccess: false, agentNamingStyle: true, notifications: { needsPersonUrl: true } });
  assert.equal(settings.active.agentNamingStyle, false);
  assert.equal(JSON.parse(file('doctor.json')).items[0].data.configPath, '~\\.codex\\config.toml');
  const runtime = file('logs/runtime.log').trimEnd().split('\n');
  assert.equal(runtime.length, 400);
  assert.equal(runtime[0], 'line 51 at ~\\work owner=<user>');
  assert.equal(file('native-runtime/personal/logs/provider.log'), 'provider ready token=<secret>\n');
  const all = JSON.stringify(bundle.files);
  for (const secret of ['Synthia', 'Greek gods', 'hooks.example', 'private memory', 'private transcript']) {
    assert.equal(all.includes(secret), false, secret);
  }
  assert.equal(bundle.redactions.home_directory, 401);
  assert.equal(bundle.redactions.username, 400);
  assert.equal(bundle.redactions.secret_assignment, 1);
});

test('a failing doctor or an unreadable log still leaves a bundle that says so', async (t) => {
  const { paths, write } = dataDirIn(t);
  write(paths.logPath, 'console started\n');
  mkdirSync(join(paths.nativePersonalDir, 'logs', 'provider.log'), { recursive: true });
  const bundle = await createDiagnosticsBundle({ paths, host: HOST, installKind: () => 'npm',
    settings: () => ({ configured: SETTINGS, active: SETTINGS }), doctor: async () => { throw new Error('clients unreadable'); } })();
  const file = (name) => bundle.files.find((entry) => entry.name === name)?.content;
  assert.deepEqual(JSON.parse(file('doctor.json')), { error: 'clients unreadable' });
  assert.equal(file('logs/runtime.log'), 'console started\n');
  assert.match(file('native-runtime/personal/logs/provider.log'), /^\(could not be read: [^)]+\)\n$/);
});

async function api(system, path, remoteAddress = '127.0.0.1', method = 'GET') {
  const sent = {};
  const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = text ? JSON.parse(text) : null; } };
  const app = { config: { personal: { spaceId: 'space-a' } } };
  try {
    sent.handled = await handleDiagnosticsApiRequest({ request: { method, headers: {}, socket: { remoteAddress } }, response,
      url: new URL(`http://127.0.0.1${path}`), app, system });
  } catch (error) {
    Object.assign(sent, mapHttpError(error));
  }
  return sent;
}

test('the route answers only this computer in the active personal space, and no Agent entry reaches it', async () => {
  const bundle = { generatedAt: '2026-11-01T08:00:00.000Z', files: [], redactions: {} };
  const system = { diagnostics: async () => bundle };
  const path = '/api/system/diagnostics?personalSpaceId=space-a';
  assert.deepEqual(await api(system, path), { status: 200, body: bundle, handled: true });
  assert.equal((await api(system, path, '192.0.2.10')).body.code, 'local_user_only');
  assert.equal((await api(system, '/api/system/diagnostics?personalSpaceId=space-b')).status, 403);
  assert.equal((await api(system, path, '127.0.0.1', 'POST')).status, 405);
  assert.equal((await api(null, path)).handled, false);

  const console = ['src/system/diagnostics-bundle.js', 'src/http/diagnostics-api-router.js'].map((file) => join(ROOT, file));
  for (const entry of ['src/mcp-server.js', 'src/agent-tools.js', 'src/mcp/create-mcp-server.js']) {
    const modules = reachableModules(join(ROOT, entry));
    assert.deepEqual(console.filter((file) => modules.has(file)), [], entry);
  }
});
