import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { agentKitExecutables } from '../../../src/agent-kits/executables.js';
import { sessionClientRecords } from '../../../src/agent-kits/session-clients.js';
import { createSessionLauncherPort } from '../../../src/agent-kits/session-launcher.js';
import { recordClaudeSessionClient } from '../../../src/agents/claude-code/session-client.js';
import { isolateHomeEnvironment, realAgentKitExecutable } from '../../../test-support/agent-kit-binaries.js';

function dataDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-claude-session-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'extensions'));
  return root;
}

test('a Claude Code hook records which client its session runs in from CLAUDE_CODE_ENTRYPOINT', async (t) => {
  const executable = await realAgentKitExecutable('agent-session-launcher');
  if (!executable) { t.skip('the pinned launcher cannot be downloaded here'); return; }
  isolateHomeEnvironment(t);
  const root = dataDirectory(t);
  const runtimeConfigPath = join(root, 'graph-runtime.json');
  const launcher = createSessionLauncherPort({ extensionsDir: join(root, 'extensions'),
    executables: agentKitExecutables({ nativeRuntimeDir: join(root, 'native-runtime'), env: { FULI_AGENT_SESSION_LAUNCHER: executable } }) });
  const record = async (sessionId, entrypoint) => {
    await recordClaudeSessionClient({ runtimeConfigPath, sessionId, launcher,
      env: entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint } });
    return sessionClientRecords(root).read('claude_code', sessionId);
  };
  assert.deepEqual(await record('desktop', 'claude-desktop'),
    { client: 'claude-desktop', source: 'Claude Code', entrypoint: 'claude-desktop' });
  assert.deepEqual(await record('terminal', 'cli'), { client: 'claude-code', source: 'Claude Code CLI', entrypoint: 'cli' });
  assert.deepEqual(await record('ide', 'claude-vscode'),
    { client: 'claude-code-unknown', source: 'Claude Code', entrypoint: 'claude-vscode' });
  assert.deepEqual(await record('older-claude'), { client: 'claude-code-unknown', source: 'Claude Code', entrypoint: null });
  // Once per session: a later hook of the same session keeps the first answer.
  assert.deepEqual(await record('desktop', 'cli'), { client: 'claude-desktop', source: 'Claude Code', entrypoint: 'claude-desktop' });
});

test('without a launcher the hook keeps the label and entry point for the console', async (t) => {
  const root = dataDirectory(t);
  const runtimeConfigPath = join(root, 'graph-runtime.json');
  // The default wiring finds no executable in a fresh data directory and never downloads from a hook.
  await recordClaudeSessionClient({ runtimeConfigPath, sessionId: 'session-1', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  assert.deepEqual(sessionClientRecords(root).read('claude_code', 'session-1'),
    { client: null, source: 'Claude Code CLI', entrypoint: 'cli' });
  assert.deepEqual(readdirSync(root).sort(), ['extensions', 'session-clients'], 'nothing was downloaded');
  assert.equal(sessionClientRecords(root).read('claude_code', 'another-session'), null);
  assert.equal(sessionClientRecords(root).read('codex', 'session-1'), null, 'records are per source application');
});
