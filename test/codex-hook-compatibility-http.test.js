// Real HTTP + real Hook subprocess, with synthetic Provider data and credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const [name, status, body, blocked, reads] of [
  ['legacy route absence', 404, { detail: 'Not Found' }, false, 1],
  ['resource absence', 404, { detail: 'Task context is unknown or superseded' }, false, 1],
  ['permission failure', 403, { detail: 'Forbidden' }, false, 1],
  ['temporary gateway outage', 503, { detail: 'Synthetic outage' }, false, 2]
]) test(`Hook executable handles ${name} through the actual HTTP client`, async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: new URL(request.url, 'http://provider.test').pathname, method: request.method });
    assert.equal(request.headers.authorization, 'Bearer synthetic-http-access');
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = await mkdtemp(join(tmpdir(), 'jvs-a-hook-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'runtime.json');
  await writeFile(config, JSON.stringify({ version: 1, personal: {
    providerUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'synthetic-http-access',
    principalId: 'synthetic-principal', spaceId: 'synthetic-space'
  }, workspaces: [] }), { mode: 0o600 });
  await writeFile(join(directory, 'adaptive-runtime-settings.json'), JSON.stringify({ version: 1, enabled: false }), { mode: 0o600 });
  const child = spawn(process.execPath, [new URL('../src/agents/codex/lifecycle-hook.js', import.meta.url).pathname,
    '--runtime-config', config, '--event', 'UserPromptSubmit'], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const finished = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.after(() => clearTimeout(timer));
  child.stdin.end(JSON.stringify({ session_id: 'synthetic-session', cwd: directory,
    prompt: 'Synthetic submission', transcript_path: join(directory, 'missing.jsonl') }));
  const [exitCode, signal] = await finished;
  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  const result = JSON.parse(stdout);
  assert.equal(result.decision === 'block', blocked);
  if (!blocked) assert.equal(typeof result.systemMessage, 'string');
  assert.equal(result.hookSpecificOutput, undefined);
  assert.deepEqual(requests, Array.from({ length: reads }, () => ({ path: '/v1/task-context-sessions/current', method: 'GET' })));
  assert.deepEqual(await readdir(join(directory, 'transcript-guards')), []);
});
