import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { codexWake } from '../packages/roundtable/src/agents/codex/wake.js';
import { parseFinalAnswer, wakeArguments } from '../packages/roundtable/src/roundtable/wake.js';

test('Codex runs read-only, resuming a session or starting in the project directory', () => {
  assert.deepEqual(wakeArguments('codex', { sessionId: 'cx-session-1' }),
    ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', 'cx-session-1', '-']);
  assert.deepEqual(wakeArguments('codex', { cwd: '/work/app' }),
    ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/work/app', '-']);
  // A group discussion wake is the same: Codex answers in the read-only sandbox.
  assert.deepEqual(wakeArguments('codex', { cwd: '/work/app', mode: 'read_only' }),
    wakeArguments('codex', { cwd: '/work/app' }));
});

// A synthetic Codex home and project with the given config.toml texts (null: no file).
function codexConfig({ user = null, project = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fuli-codex-config-'));
  const codexHome = join(home, 'codex-home');
  const cwd = join(home, 'work', 'app');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  mkdirSync(codexHome);
  if (user !== null) writeFileSync(join(codexHome, 'config.toml'), user);
  if (project !== null) {
    mkdirSync(join(cwd, '.codex'));
    writeFileSync(join(cwd, '.codex', 'config.toml'), project);
  }
  return { cwd, home, env: { CODEX_HOME: codexHome } };
}

const PLUGINS_OFF = ['-c', 'plugins={ _default = { enabled = false } }'];
const APPS_OFF = ['-c', 'features.apps=false'];

test('an ask from another computer loads FULI\'s own server and turns off every other server, plugin and app', () => {
  const entry = { command: 'C:\\synthetic\\node.exe', args: ['C:\\synthetic\\mcp-server.js', '--source-application', 'codex'],
    settings: { enabled: true, startup_timeout_sec: 30, default_tools_approval_mode: 'auto' } };
  const fuli = 'fuli = { command = "C:\\\\synthetic\\\\node.exe", args = ["C:\\\\synthetic\\\\mcp-server.js","--source-application","codex"], '
    + 'enabled = true, startup_timeout_sec = 30, default_tools_approval_mode = "auto" }';
  const config = codexConfig({
    user: ['[mcp_servers.fuli]', 'command = "node"', '[mcp_servers.synthetic-notes]', 'command = "notes"',
      '[mcp_servers."phone.bridge"]', 'url = "http://127.0.0.1:9/mcp"', '[plugins."synthetic@market"]', 'enabled = true', ''].join('\n'),
    project: 'mcp_servers.project-tool = { command = "tool" }\n' });
  const others = '"synthetic-notes" = { enabled = false }, "phone.bridge" = { enabled = false }, "project-tool" = { enabled = false }';
  const plugins = ['-c', 'plugins={ _default = { enabled = false }, "synthetic@market" = { enabled = false } }'];
  const args = wakeArguments('codex', { ...config, mode: 'read_only', delegated: true, mcpServers: { fuli: entry } });
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', config.cwd,
    '-c', `mcp_servers={ ${fuli}, ${others} }`, ...plugins, ...APPS_OFF,
    '-c', 'mcp_servers.fuli.env_vars=["FULI_ROUNDTABLE_DELEGATION","FULI_ROUNDTABLE_PEER_DEPTH"]', '-']);
  // Resuming in the session's folder carries the same overrides.
  assert.deepEqual(wakeArguments('codex', { ...config, sessionId: 'cx-session-1', mode: 'read_only', mcpServers: { fuli: entry } }),
    ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', ...args.slice(7, 13), 'cx-session-1', '-']);
  // Without FULI's entry the person's own FULI server is turned off as well, and no delegation variables are set.
  assert.deepEqual(wakeArguments('codex', { ...config, mode: 'read_only', delegated: true, mcpServers: {} }).slice(7),
    ['-c', `mcp_servers={ "fuli" = { enabled = false }, ${others} }`, ...plugins, ...APPS_OFF, '-']);
  assert.deepEqual(wakeArguments('codex', { ...config, mode: 'answer', mcpServers: { fuli: entry } }), wakeArguments('codex', { cwd: config.cwd }));
  assert.throws(() => wakeArguments('codex', { cwd: '/w', mode: 'worktree_edit' }), /Invalid wake mode/);
});

test('a Codex configuration with no servers, or no configuration, leaves no MCP server, plugin or app', () => {
  for (const config of [codexConfig(), codexConfig({ user: 'model = "synthetic"\n' })]) {
    assert.deepEqual(wakeArguments('codex', { ...config, mode: 'read_only', mcpServers: {} }),
      ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', config.cwd,
        '-c', 'mcp_servers={  }', ...PLUGINS_OFF, ...APPS_OFF, '-']);
  }
});

test('a Codex configuration that cannot be read refuses the wake instead of loading its servers', () => {
  const broken = codexConfig({ user: '[mcp_servers.synthetic\ncommand = ' });
  const folder = codexConfig({ project: '' });
  rmSync(join(folder.cwd, '.codex', 'config.toml'));
  mkdirSync(join(folder.cwd, '.codex', 'config.toml'));
  for (const config of [broken, folder]) {
    assert.throws(() => wakeArguments('codex', { ...config, mode: 'read_only', mcpServers: {} }),
      { code: 'wake_failed', detail: 'mcp_config_unreadable' });
  }
  // A wake that keeps the person's own servers does not read the configuration.
  assert.equal(wakeArguments('codex', { ...broken, mode: 'answer' }).includes('features.apps=false'), false);
});

test('Codex answers are the last agent message of a completed turn', () => {
  assert.deepEqual(parseFinalAnswer('codex', { code: 0, stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'cx-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    JSON.stringify({ type: 'turn.completed' })].join('\n') }), { body: 'done', sessionId: 'cx-1' });
  assert.throws(() => parseFinalAnswer('codex', { code: 0, stdout: JSON.stringify({ type: 'turn.failed' }) }), /did not return an answer/);
  assert.throws(() => parseFinalAnswer('codex', { code: 0, stdout:
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }) }), /did not return an answer/);
});

test('Codex sessions resume from the directory in their session metadata', () => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-codex-wake-'));
  mkdirSync(join(home, '.codex', 'sessions', '2026', '10', '10'), { recursive: true });
  writeFileSync(join(home, '.codex', 'sessions', '2026', '10', '10', 'rollout-2026-10-10T00-00-00-cx-session-1.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/app' } })}\n`);
  assert.equal(codexWake.sessionDirectory('cx-session-1', { home, env: {} }), '/work/app');
  assert.equal(codexWake.sessionDirectory('missing-session', { home, env: {} }), null);
});

test('On Windows the newest bundled Codex CLI is used when PATH has none', () => {
  const local = mkdtempSync(join(tmpdir(), 'fuli-codex-bin-'));
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  mkdirSync(join(bin, 'old'), { recursive: true });
  mkdirSync(join(bin, 'new'), { recursive: true });
  writeFileSync(join(bin, 'old', 'codex.exe'), '');
  writeFileSync(join(bin, 'new', 'codex.exe'), '');
  utimesSync(join(bin, 'old', 'codex.exe'), new Date('2026-01-01'), new Date('2026-01-01'));
  utimesSync(join(bin, 'new', 'codex.exe'), new Date('2026-10-01'), new Date('2026-10-01'));
  const command = codexWake.resolveCommand({ env: { LOCALAPPDATA: local }, which: () => null, platform: 'win32' });
  assert.equal(command, join(bin, 'new', 'codex.exe'));
});

test('a Codex session is idle only when its log shows the last turn ended; unknown counts as running', () => {
  const home = mkdtempSync(join(tmpdir(), 'fuli-codex-turn-'));
  const day = join(home, '.codex', 'sessions', '2026', '11', '11');
  mkdirSync(day, { recursive: true });
  const file = join(day, 'rollout-2026-11-11T00-00-00-cx-session-2.jsonl');
  const event = type => JSON.stringify({ type: 'event_msg', payload: { type } });
  const meta = JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/app' } });
  const write = (...lines) => writeFileSync(file, lines.join('\n'));
  const running = () => codexWake.turnRunning('cx-session-2', { home, env: {} });
  write(meta, event('task_started'), event('task_complete'), event('task_started'), '');
  assert.equal(running(), true);
  write(meta, event('task_started'), event('task_complete'), '');
  assert.equal(running(), false);
  write(meta, event('task_started'), event('turn_aborted'), '');
  assert.equal(running(), false);
  write(meta, '');
  assert.equal(running(), false, 'a whole log in which no turn ever started');
  // A long tool wait: the turn started, the log has been quiet since. No age makes it idle.
  write(meta, event('task_started'), JSON.stringify({ type: 'response_item', payload: { type: 'function_call' } }), '');
  assert.equal(running(), true);
  // One huge turn: its start is outside the read tail and no end is in it.
  const filler = JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'x'.repeat(4000) } });
  write(meta, event('task_started'), ...Array(100).fill(filler), '');
  assert.equal(running(), true, 'a start outside the tail with no end read is not idle');
  write(meta, event('task_started'), ...Array(100).fill(filler), event('task_complete'), '');
  assert.equal(running(), false);
  // A cut last line (the end still being written) is not evidence of an end.
  write(meta, event('task_started'), event('task_complete').slice(0, 20));
  assert.equal(running(), true);
  // A new start still being written, after a finished turn or as the very first turn.
  write(meta, event('task_started'), event('task_complete'), event('task_started').slice(0, 20));
  assert.equal(running(), true, 'a partial new start after an ended turn');
  write(meta, event('task_started').slice(0, 20));
  assert.equal(running(), true, 'a partial first start');
  // A damaged line in the middle is no evidence either.
  write(meta, event('task_started'), '{"type":"event_msg",', event('task_complete'), '');
  assert.equal(running(), true, 'an unreadable middle line');
  // Only the cut first line of a long tail is expected to be partial.
  write(meta, event('task_started'), ...Array(100).fill(filler), event('task_complete'), '');
  assert.equal(running(), false, 'the cut first line of the tail window is not counted');
  assert.equal(codexWake.turnRunning('missing-session', { home, env: {} }), false);
});
