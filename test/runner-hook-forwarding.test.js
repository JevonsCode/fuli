import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceCertificate, deviceIdentity, loadDeviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { CODEX_RUNNER_PROMPT_TIMEOUT_MS, CODEX_RUNNER_STOP_TIMEOUT_MS, codexHookTimeoutMs } from '../src/agents/codex/hook-contract.js';
import { resolveCallerProjectPath } from '../src/graphiti/caller-workspace.js';
import { quietForwardedOutput } from '../src/runner/hook-scope.js';
import { forwardHookToHost } from '../src/runner/hook-forwarding.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { RunnerStore } from '../src/runner/runner-store.js';

const PROJECTS = [{ project_id: 'widgets', profile: { sources: [{ kind: 'repository', uri: 'https://example.test/team/widgets' }] } }];
const SESSION = '0b5f3c2e-6d4a-4f8e-9a1b-2c3d4e5f6a7b';

test('a forwarded host notification stays silent with an older host but retains an ownership block', () => {
  const old = JSON.stringify({ hookSpecificOutput: { additionalContext: 'Synthetic task context.' } });
  assert.deepEqual(JSON.parse(quietForwardedOutput(old)), {});
  const block = JSON.stringify({ decision: 'block', reason: 'Synthetic ownership hold failed.' });
  assert.equal(quietForwardedOutput(block), block);
});

// A paired runner (its data directory, with its own device identity) and a host whose prompt hook records its call.
async function pairedRunner(t, { runHook }) {
  const host = deviceIdentity(await createDeviceCertificate());
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-hook-')));
  const dataDir = path.join(base, 'runner-data');
  const runner = await loadDeviceIdentity(path.join(dataDir, 'peer'));
  const hostStore = new RunnerHostStore(':memory:');
  hostStore.invite({ code: 'synthetic-invitation-code-0002', name: 'Runner B' });
  hostStore.pair({ code: 'synthetic-invitation-code-0002', fingerprint: runner.fingerprint, name: 'Runner B' });
  const routes = createRunnerRoutes({ app: {}, store: hostStore, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(), runtimeConfigPath: '/host/data/graph-runtime.json', runHook });
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, route: routes.handle,
    sourceAllowed: () => true });
  const store = new RunnerStore(path.join(dataDir, 'runner', 'runner.sqlite'));
  store.saveHost({ name: 'Host A', fingerprint: host.fingerprint, certPem: host.certPem, port: listener.port, addresses: ['127.0.0.1'] });
  store.close();
  const root = path.join(base, 'my-clone');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@example.test:team/widgets.git\n');
  t.after(async () => {
    await listener.close();
    await routes.close();
    hostStore.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { dataDir, root };
}

const hookStdin = (root) => [Buffer.from(JSON.stringify({ session_id: SESSION, turn_id: 't1', cwd: root, prompt: 'tidy the cart',
  transcript_path: '/runner/only/transcript.jsonl', hook_event_name: 'UserPromptSubmit' }))];

test('a runner client\'s prompt hook enters the task on the host for its own session, in the folder it is in', async (t) => {
  const calls = [];
  const { dataDir, root } = await pairedRunner(t, { runHook: async (call) => {
    const payload = JSON.parse(Buffer.concat(call.stdin).toString('utf8'));
    calls.push({ call, payload, resolution: resolveCallerProjectPath(payload.cwd, PROJECTS) });
    return { stdout: '{"hookSpecificOutput":{"additionalContext":"task entered"}}\n', exitCode: 0 };
  } });

  const answer = await forwardHookToHost({ dataDir, client: 'codex', event: 'UserPromptSubmit',
    env: { CODEX_HOME: '/runner/codex', NOT_A_HOOK_VARIABLE: 'x' }, stdin: hookStdin(root), deadlineAt: Date.now() + 20_000 });

  assert.match(answer.stdout, /task entered/);
  const [{ call, payload, resolution }] = calls;
  assert.equal(payload.session_id, SESSION, 'the client\'s own session, which its MCP processes never see');
  assert.equal(payload.transcript_path, undefined, 'the transcript stays on the runner');
  assert.deepEqual(resolution, { status: 'matched', basis: 'git_remote', personalProjectId: 'widgets' });
  assert.deepEqual(call.argv, ['--fuli-lifecycle', '--runtime-config', '/host/data/graph-runtime.json', '--event', 'UserPromptSubmit']);
  assert.equal(call.env.NOT_A_HOOK_VARIABLE, undefined, 'only the client\'s named hook variables cross');
});

test('a hook the host cannot take gives the runner nothing to print, so it falls back to entering through MCP', async (t) => {
  const { dataDir, root } = await pairedRunner(t, { runHook: async () => { throw new Error('graph away'); } });
  assert.equal(await forwardHookToHost({ dataDir, client: 'codex', event: 'UserPromptSubmit', env: {},
    stdin: hookStdin(root), deadlineAt: Date.now() + 20_000 }), null);
  assert.equal(await forwardHookToHost({ dataDir, client: 'codex', event: 'UserPromptSubmit', env: {},
    stdin: [Buffer.from('not json')], deadlineAt: Date.now() + 20_000 }), null);
});

test('a runner\'s Codex prompt hook waits for the host\'s whole entry and the trip there, inside Codex\'s hook timeout', () => {
  const entry = codexHookTimeoutMs(['--event', 'UserPromptSubmit']);
  // The host enters the task under this limit; the runner gets it plus the hop and its own margin.
  assert.ok(CODEX_RUNNER_PROMPT_TIMEOUT_MS - 2_000 > entry);
  assert.ok(CODEX_RUNNER_PROMPT_TIMEOUT_MS < 30_000, 'Codex stops a hook at 30 s');
});

test('a runner client\'s turn end closes its task on the host; other hooks stay on the runner', async (t) => {
  const calls = [];
  const { dataDir, root } = await pairedRunner(t, { runHook: async (call) => {
    calls.push(call.argv.at(-1));
    return { stdout: '{}\n', exitCode: 0 };
  } });
  const stop = await forwardHookToHost({ dataDir, client: 'codex', event: 'Stop', env: {},
    stdin: [Buffer.from(JSON.stringify({ session_id: SESSION, turn_id: 't1', cwd: root, hook_event_name: 'Stop',
      transcript_path: '/runner/only/transcript.jsonl', last_assistant_message: 'done' }))], deadlineAt: Date.now() + 20_000 });
  assert.equal(stop.stdout, '{}\n');
  assert.equal(await forwardHookToHost({ dataDir, client: 'codex', event: 'SessionStart', env: {},
    stdin: hookStdin(root), deadlineAt: Date.now() + 20_000 }), null);
  assert.deepEqual(calls, ['Stop']);
  // The host's Codex Stop runs within its 5 s; the runner waits for that and the trip.
  assert.ok(CODEX_RUNNER_STOP_TIMEOUT_MS > codexHookTimeoutMs(['--event', 'Stop']) + 2_000);
});
