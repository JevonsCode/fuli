import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { wakeAgent, runProcess } from '../packages/roundtable/src/roundtable/wake.js';
import { wakeAttemptRecord } from '../packages/roundtable/src/roundtable/wake-failure.js';
import { createFuliRoundtableHost } from '../src/graphiti/roundtable-host.js';

// Synthetic only: every child is this Node binary running a short script, never a real client.
const SECRET_PATH = 'C:\\Users\\synthetic-person\\Private Repo\\notes.txt';
const POSIX_PATH = '/home/synthetic-person/work/secret.env';
const TOKEN = 'sk-synthetic' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const CREDENTIAL_URL = 'https://synthetic-user:synthetic-pass@example.invalid/hook?token=synthetic-value';

function scripted(script) {
  return (_command, _args, options) => runProcess(process.execPath, ['-e', script], { ...options, env: process.env });
}

function wakeWith(script, options = {}) {
  return wakeAgent({ client: 'codex', cwd: process.cwd(), prompt: 'Synthetic question', timeoutMs: 10_000,
    env: { FULI_CODEX_BIN: 'synthetic-codex' }, run: scripted(script), ...options });
}

async function failure(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('the wake answered');
}

test('each way a wake fails keeps its outward code and a detail from the closed set', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'fuli-wake-failure-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const notExecutable = join(folder, 'synthetic-client.txt');
  writeFileSync(notExecutable, 'not a program');
  const cases = [
    ['missing command', () => wakeAgent({ client: 'codex', cwd: folder, prompt: 'q', env: { FULI_CODEX_BIN: join(folder, 'missing-client.exe') } }),
      'client_unavailable', 'client_not_found'],
    ['file that is no program', () => wakeAgent({ client: 'codex', cwd: folder, prompt: 'q', env: { FULI_CODEX_BIN: notExecutable } }),
      'client_unavailable', 'spawn_error'],
    ['not logged in', () => wakeWith('console.log(JSON.stringify({ error: "authentication_failed" }))'),
      'client_login_required', 'login_required'],
    ['non-zero exit', () => wakeWith('process.stderr.write("synthetic crash\\n"); process.exit(3)'),
      'wake_failed', 'client_exit_nonzero'],
    ['clean exit without an answer', () => wakeWith('process.stdout.write("{\\"type\\":\\"thread.started\\"}\\n")'),
      'wake_failed', 'no_final_answer'],
    ['too much output', () => runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'],
      { cwd: folder, env: process.env, input: '', timeoutMs: 10_000, maxOutputBytes: 100 }), 'wake_failed', 'output_too_large'],
    ['no answer in time', () => wakeWith('setTimeout(() => {}, 10_000)', { timeoutMs: 300 }), 'wake_timeout', 'timed_out'],
    ['cancelled', () => wakeWith('setTimeout(() => {}, 10_000)', { signal: AbortSignal.timeout(300) }), 'cancelled', 'cancelled'],
  ];
  for (const [name, run, code, detail] of cases) {
    const error = await failure(run());
    assert.deepEqual([error.code, error.detail], [code, detail], name);
  }
  const exited = await failure(wakeWith('process.exit(7)'));
  assert.deepEqual([exited.exitCode, exited.signal], [7, null]);
});

test('stderr is kept only as its last 4 KB, with the stdout tail when no answer came', async () => {
  const error = await failure(wakeWith('process.stderr.write("early-".repeat(5000) + "LAST-LINE"); '
    + 'process.stdout.write("partial output\\n"); process.exit(2)'));
  assert.equal(error.output.stderr.length, 4096);
  assert.ok(error.output.stderr.endsWith('LAST-LINE'));
  assert.match(error.output.stdout, /partial output/);
});

test('the kept summary is redacted by the host and bounded; without a redactor only codes remain', async () => {
  const error = await failure(wakeWith(`process.stderr.write(${JSON.stringify(
    `failed reading ${SECRET_PATH}\nand ${POSIX_PATH}\nwith ${TOKEN}\ncalling ${CREDENTIAL_URL}\n${'filler '.repeat(400)}`)}); process.exit(1)`));
  const host = createFuliRoundtableHost({ config: { personal: { spaceId: 'synthetic-space' } } });
  const kept = wakeAttemptRecord({ client: 'codex', sessionId: null, error, durationMs: 12, redact: host.redactDiagnostic });
  assert.deepEqual([kept.code, kept.detail, kept.exitCode, kept.sessionMode], ['wake_failed', 'client_exit_nonzero', 1, 'new']);
  assert.ok(kept.outputSummary.length <= 600);
  for (const secret of ['synthetic-person', 'Private Repo', 'secret.env', TOKEN, 'synthetic-pass', 'synthetic-user', 'synthetic-value']) {
    assert.ok(!kept.outputSummary.includes(secret), secret);
  }
  assert.match(kept.outputSummary, /failed reading \[path\]/);
  const bare = wakeAttemptRecord({ client: 'codex', sessionId: 'synthetic-session-1', error, durationMs: 12 });
  assert.deepEqual([bare.outputSummary, bare.detail, bare.exitCode, bare.sessionMode], [null, 'client_exit_nonzero', 1, 'resumed']);
});
