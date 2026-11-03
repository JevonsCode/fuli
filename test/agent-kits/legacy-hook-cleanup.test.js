import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { retireLegacyHooks } from '../../src/agent-kits/legacy-hook-cleanup.js';

// A temporary home with synthetic client files only.
function home(t) {
  const homeDir = mkdtempSync(join(tmpdir(), 'fuli-legacy-hooks-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const backupsDir = join(homeDir, 'fuli-data', 'backups', 'agents');
  const put = (relative, text) => {
    mkdirSync(dirname(join(homeDir, relative)), { recursive: true });
    writeFileSync(join(homeDir, relative), text);
  };
  const read = (relative) => readFileSync(join(homeDir, relative), 'utf8');
  const retire = (ids, env = {}) => retireLegacyHooks(ids, { env, homeDir, backupsDir, now: () => new Date('2026-11-03T08:00:00Z') });
  const backups = (clientId) => {
    const directory = join(backupsDir, clientId, 'legacy-hooks');
    return existsSync(directory) ? Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), 'utf8')])) : {};
  };
  return { homeDir, put, read, retire, backups };
}

const legacy = (tool) => ({ type: 'mcp_tool', server: 'fuli', tool, input: { sessionId: '${session_id}' }, timeout: 30 });
const userHook = { type: 'command', command: 'echo stop' };
const commandHook = { type: 'command', command: 'node lifecycle-hook.js --fuli-claude-lifecycle --event Stop', timeout: 30 };
// What an earlier FULI left: its MCP-tool hooks beside the person's own and the current command hooks.
const settings = (extra = {}) => JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, ...extra, hooks: {
  UserPromptSubmit: [{ hooks: [legacy('begin_task_context')] }],
  Stop: [{ hooks: [userHook, legacy('verify_task_checkpoint')] }, { hooks: [commandHook] }],
  // Another server's tool of the same name is not FULI's.
  SessionStart: [{ hooks: [{ ...legacy('begin_task_context'), server: 'other' }] }]
} }, null, 2);

test('Claude Code: FULI\'s legacy MCP-tool hooks are removed after a backup; every other hook stays', (t) => {
  const h = home(t);
  const original = settings();
  h.put('.claude/settings.json', original);
  const changed = h.retire(['claude-code', 'gemini']);
  assert.deepEqual(changed, [join(h.homeDir, '.claude', 'settings.json')]);
  assert.deepEqual(JSON.parse(h.read('.claude/settings.json')), { permissions: { allow: ['Bash(ls)'] }, hooks: {
    Stop: [{ hooks: [userHook] }, { hooks: [commandHook] }],
    SessionStart: [{ hooks: [{ ...legacy('begin_task_context'), server: 'other' }] }]
  } });
  assert.deepEqual(h.backups('claude-code'), { 'settings.json-2026-11-03T08-00-00-000Z': original });
  // Once clean, nothing is written or backed up again.
  const clean = h.read('.claude/settings.json');
  assert.deepEqual(h.retire(['claude-code']), []);
  assert.equal(h.read('.claude/settings.json'), clean);
  assert.equal(Object.keys(h.backups('claude-code')).length, 1);
});

test('Codex: legacy hooks go from hooks.json and config.toml under CODEX_HOME; the person\'s hooks and tables stay', (t) => {
  const h = home(t);
  const hooksJson = JSON.stringify({ description: 'mine', hooks: { Stop: [{ hooks: [legacy('verify_task_checkpoint')] }],
    UserPromptSubmit: [{ hooks: [userHook] }] } });
  const toml = ['model = "gpt-5"', '',
    '[[hooks.UserPromptSubmit]]', '', '[[hooks.UserPromptSubmit.hooks]]', 'type = "mcp_tool"', 'server = "fuli"',
    'tool = "begin_task_context"', 'timeout = 30', '', '[hooks.UserPromptSubmit.hooks.input]', 'prompt = "${prompt}"', '',
    '[[hooks.Stop]]', '', '[[hooks.Stop.hooks]]', 'type = "command"', 'command = "echo stop"', '',
    '[[hooks.Stop.hooks]]', 'type = "mcp_tool"', 'server = "fuli"', 'tool = "verify_task_checkpoint"', 'timeout = 30', '',
    '[mcp_servers.other]', 'command = "other"', ''].join('\n');
  h.put('codex-home/hooks.json', hooksJson);
  h.put('codex-home/config.toml', toml);
  const changed = h.retire(['codex'], { CODEX_HOME: join(h.homeDir, 'codex-home') });
  assert.equal(changed.length, 2);
  assert.deepEqual(JSON.parse(h.read('codex-home/hooks.json')), { description: 'mine', hooks: { UserPromptSubmit: [{ hooks: [userHook] }] } });
  assert.equal(h.read('codex-home/config.toml'), ['model = "gpt-5"', '',
    '[[hooks.Stop]]', '', '[[hooks.Stop.hooks]]', 'type = "command"', 'command = "echo stop"', '',
    '[mcp_servers.other]', 'command = "other"', ''].join('\n'));
  assert.deepEqual(h.backups('codex'), { 'hooks.json-2026-11-03T08-00-00-000Z': hooksJson, 'config.toml-2026-11-03T08-00-00-000Z': toml });
});

test('without legacy hooks, or without the files, nothing is touched or backed up', (t) => {
  const h = home(t);
  assert.deepEqual(h.retire(['claude-code', 'codex']), []);
  assert.equal(existsSync(join(h.homeDir, '.claude')), false);
  const mine = JSON.stringify({ hooks: { Stop: [{ hooks: [userHook, commandHook] }] } });
  h.put('.claude/settings.json', mine);
  h.put('.codex/config.toml', '[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"\n');
  h.put('.codex/hooks.json', '{ not json');
  assert.deepEqual(h.retire(['claude-code', 'codex']), []);
  assert.equal(h.read('.claude/settings.json'), mine);
  assert.equal(h.read('.codex/hooks.json'), '{ not json');
  assert.deepEqual([h.backups('claude-code'), h.backups('codex')], [{}, {}]);
});
