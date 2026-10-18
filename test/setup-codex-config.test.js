import assert from 'node:assert/strict';
import test from 'node:test';

import {
  existingFuliArgs,
  connectCodex,
  disconnectCodex,
  removeFuliTables,
  replaceFuliTable
} from '../src/setup/codex-config.js';

const AGENT = Object.freeze({
  id: 'codex', label: 'Codex', configPath: '/user/.codex/config.toml'
});
const AGENT_WITH_HOOKS = Object.freeze({
  ...AGENT, hooksPath: '/user/.codex/hooks.json'
});
const CONTEXT = Object.freeze({
  nodePath: '/runtime/node',
  mcpServerPath: '/package/src/mcp-server.js',
  runtimeConfigPath: '/data/graph-runtime.json'
});

test('Codex config preserves unrelated settings and replaces all old Fuli tables', () => {
  const current = [
    'model = "gpt-current"',
    '',
    '[mcp_servers.fuli]',
    'command = "old"',
    '',
    '[mcp_servers.fuli.env]',
    'OLD = "value"',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    ''
  ].join('\n');
  const next = replaceFuliTable(current, {
    command: CONTEXT.nodePath,
    args: [CONTEXT.mcpServerPath, '--runtime-config', CONTEXT.runtimeConfigPath]
  });

  assert.match(next, /model = "gpt-current"/);
  assert.match(next, /\[mcp_servers\.other]/);
  assert.equal((next.match(/\[mcp_servers\.fuli]/g) ?? []).length, 1);
  assert.doesNotMatch(next, /OLD|command = "old"/);
  assert.match(next, /required = true/);
  assert.match(next, /--runtime-config/);
});

test('Codex connector writes the merged user config', () => {
  let write;
  const result = connectCodex(AGENT, CONTEXT, {
    readConfig: () => 'approval_policy = "on-request"\n',
    writeConfig: (path, value) => { write = { path, value }; }
  });

  assert.deepEqual(result, {
    id: 'codex',
    label: 'Codex',
    status: 'connected',
    newTaskRequired: true
  });
  assert.equal(write.path, AGENT.configPath);
  assert.match(write.value, /approval_policy = "on-request"/);
  assert.match(write.value, /command = "\/runtime\/node"/);
  assert.match(write.value, /"--source-application", "codex"/);
});

test('Codex connector avoids rewriting a current config and reports no reload', () => {
  const current = replaceFuliTable('', {
    command: CONTEXT.nodePath,
    args: [
      CONTEXT.mcpServerPath,
      '--runtime-config',
      CONTEXT.runtimeConfigPath,
      '--source-application',
      'codex',
      '--tool-profile',
      'chat'
    ]
  });
  let writes = 0;
  const result = connectCodex(AGENT, CONTEXT, {
    readConfig: () => current,
    writeConfig: () => { writes += 1; },
    installBootstrap: () => ({ changed: false })
  });

  assert.equal(writes, 0);
  assert.equal(result.newTaskRequired, false);
});

test('Codex gets the chat tool profile, and an explicit profile in its config survives', () => {
  const legacy = replaceFuliTable('', { command: CONTEXT.nodePath,
    args: [CONTEXT.mcpServerPath, '--runtime-config', CONTEXT.runtimeConfigPath, '--source-application', 'codex'] });
  const explicit = replaceFuliTable('', { command: CONTEXT.nodePath,
    args: [CONTEXT.mcpServerPath, '--runtime-config', CONTEXT.runtimeConfigPath, '--source-application', 'codex', '--tool-profile', 'full'] });
  const written = source => {
    let value = '';
    connectCodex(AGENT, CONTEXT, { readConfig: () => source, writeConfig: (_path, next) => { value = next; },
      installBootstrap: () => ({ changed: false }) });
    return value || source;
  };
  assert.match(written(''), /"--tool-profile", "chat"]/);
  assert.match(written(legacy), /"--tool-profile", "chat"]/);
  assert.match(written(explicit), /"--tool-profile", "full"]/);
});

test('Codex connector keeps one hook representation when config.toml already has hooks', () => {
  const current = [
    '[[hooks.Stop]]',
    '',
    '[[hooks.Stop.hooks]]',
    'command = "notify-existing"',
    'type = "command"',
    ''
  ].join('\n');
  const currentHooks = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{
        type: 'mcp_tool', server: 'fuli', tool: 'begin_task_context',
        input: { sessionId: '${session_id}' }
      }] }],
      Stop: [{ hooks: [{
        type: 'mcp_tool', server: 'fuli', tool: 'verify_task_checkpoint',
        input: { sessionId: '${session_id}' }
      }] }]
    }
  };
  const writes = [];

  const result = connectCodex(AGENT_WITH_HOOKS, CONTEXT, {
    readConfig: () => current,
    writeConfig: (path, value) => { writes.push({ path, value }); },
    readHooks: () => currentHooks,
    writeHooks: (path, value) => { writes.push({ path, value }); },
    installBootstrap: () => ({ changed: false }),
    installHooks: () => {
      throw new Error('separate hooks.json installation must not run');
    }
  });

  const configWrite = writes.find(({ path }) => path === AGENT.configPath);
  const hooksWrite = writes.find(({ path }) => path === AGENT_WITH_HOOKS.hooksPath);
  assert.match(configWrite.value, /command = "notify-existing"/);
  assert.match(configWrite.value,
    /\[\[hooks\.UserPromptSubmit]]\n\n\[\[hooks\.UserPromptSubmit\.hooks]]\n/);
  assert.match(configWrite.value, /--fuli-lifecycle.*--event.*UserPromptSubmit/);
  assert.match(configWrite.value,
    /\[\[hooks\.Stop]]\n\n\[\[hooks\.Stop\.hooks]]\n/);
  assert.match(configWrite.value,
    /type = "command"\ncommand = .*agents\/codex\/lifecycle-hook\.js/);
  assert.match(configWrite.value, /--fuli-lifecycle.*--event.*Stop/);
  assert.doesNotMatch(configWrite.value, /tool = "verify_task_checkpoint"/);
  assert.deepEqual(hooksWrite.value, {});
  assert.equal(result.trustReviewRequired, true);
  assert.equal(result.newTaskRequired, true);
});

test('Codex consolidated TOML hooks report no reload or trust review on an idempotent reconnect', () => {
  let config = [
    '[[hooks.Stop]]',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "notify-existing"',
    ''
  ].join('\n');
  let hooks = {};
  const writes = [];
  const options = {
    readConfig: () => config,
    writeConfig: (_path, value) => {
      writes.push(AGENT.configPath);
      config = value;
    },
    readHooks: () => structuredClone(hooks),
    writeHooks: (_path, value) => {
      writes.push(AGENT_WITH_HOOKS.hooksPath);
      hooks = structuredClone(value);
    },
    installBootstrap: () => ({ changed: false })
  };

  const first = connectCodex(AGENT_WITH_HOOKS, CONTEXT, options);
  assert.equal(first.newTaskRequired, true);
  assert.equal(first.trustReviewRequired, true);
  writes.length = 0;

  const second = connectCodex(AGENT_WITH_HOOKS, CONTEXT, options);
  assert.equal(second.newTaskRequired, false);
  assert.equal(Object.hasOwn(second, 'trustReviewRequired'), false);
  assert.deepEqual(writes, []);
});

test('Codex connector rejects mixed hook representations before bootstrap or config writes', () => {
  const current = [
    '[[hooks.Stop]]',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    'command = "notify-existing"',
    ''
  ].join('\n');
  let bootstrapCalls = 0;
  let writes = 0;

  assert.throws(() => connectCodex(AGENT_WITH_HOOKS, CONTEXT, {
    readConfig: () => current,
    writeConfig: () => { writes += 1; },
    readHooks: () => ({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'another-user-hook' }] }]
      }
    }),
    writeHooks: () => { writes += 1; },
    installBootstrap: () => {
      bootstrapCalls += 1;
      return { changed: true };
    }
  }), /unrelated hooks in both/);

  assert.equal(bootstrapCalls, 0);
  assert.equal(writes, 0);
});

test('Codex disconnect removes only Fuli tables and keeps unrelated settings', () => {
  const current = [
    'model = "gpt-current"',
    '',
    '[mcp_servers.fuli]',
    'command = "node"',
    '',
    '[mcp_servers.fuli.env]',
    'TOKEN = "not-copied"',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    ''
  ].join('\n');
  const next = removeFuliTables(current);
  assert.match(next, /model = "gpt-current"/);
  assert.match(next, /\[mcp_servers\.other]/);
  assert.doesNotMatch(next, /mcp_servers\.fuli|TOKEN/);

  let write = null;
  const result = disconnectCodex(AGENT, {
    fileExists: () => true,
    readConfig: () => current,
    writeConfig: (path, value) => { write = { path, value }; }
  });
  assert.equal(result.status, 'disconnected');
  assert.equal(write.path, AGENT.configPath);
  assert.equal(write.value, next);
});

test('Codex disconnect removes consolidated Fuli hooks and preserves unrelated hooks', () => {
  const current = [
    '[[hooks.Stop]]',
    '',
    '[[hooks.Stop.hooks]]',
    'command = "notify-existing"',
    'type = "command"',
    '',
    '[[hooks.UserPromptSubmit]]',
    '',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "mcp_tool"',
    'server = "fuli"',
    'tool = "begin_task_context"',
    '',
    '[hooks.UserPromptSubmit.hooks.input]',
    'sessionId = "${session_id}"',
    '',
    '[[hooks.Stop]]',
    '',
    '[[hooks.Stop.hooks]]',
    'type = "mcp_tool"',
    'server = "fuli"',
    'tool = "verify_task_checkpoint"',
    '',
    '[hooks.Stop.hooks.input]',
    'sessionId = "${session_id}"',
    '',
    '[mcp_servers.fuli]',
    'command = "node"',
    ''
  ].join('\n');
  let write = null;

  disconnectCodex(AGENT_WITH_HOOKS, {
    fileExists: () => true,
    readConfig: () => current,
    writeConfig: (path, value) => { write = { path, value }; },
    removeBootstrap: () => ({ changed: false }),
    removeHooks: () => ({ changed: false })
  });

  assert.match(write.value, /command = "notify-existing"/);
  assert.doesNotMatch(write.value, /mcp_servers\.fuli/);
  assert.doesNotMatch(write.value, /begin_task_context|verify_task_checkpoint/);
});

test('an explicit Codex profile survives every valid TOML form and an unparseable file', () => {
  const forms = {
    quotedTable: '[mcp_servers."fuli"]\ncommand = "/node"\nargs = ["/srv.js", "--source-application", "codex", "--tool-profile", "full"]\n',
    multiline: '[mcp_servers.fuli]\ncommand = "/node"\nargs = [\n  "/srv.js",\n  "--tool-profile",\n  "full",\n]\n',
    literalStrings: "[mcp_servers.fuli]\ncommand = '/node'\nargs = ['/srv.js', '--tool-profile', 'full']\n",
    inlineComment: '[mcp_servers.fuli]\ncommand = "/node"\nargs = ["/srv.js", "--tool-profile", "full"] # keep full\n',
    unparseable: '[mcp_servers.fuli\nargs = ["/srv.js", "--tool-profile", "full"]\n',
  };
  for (const [name, source] of Object.entries(forms)) {
    const args = existingFuliArgs(source);
    assert.equal(args[args.indexOf('--tool-profile') + 1], 'full', name);
  }
  assert.deepEqual(existingFuliArgs('[other]\nkey = 1\n'), []);
});

test('an unparseable file only reads the profile from the fuli table, never another server or a comment', () => {
  const otherServerFirst = 'broken=[\n[mcp_servers.other]\nargs=["--tool-profile","chat"]\n[mcp_servers.fuli]\nargs=["--tool-profile","full"]\n';
  assert.deepEqual(existingFuliArgs(otherServerFirst), ['--tool-profile', 'full']);
  const commentedOut = 'broken=[\n[mcp_servers.fuli]\n# args=["--tool-profile","chat"]\nargs=["/srv.js", # server\n  "--tool-profile", "full"]\n';
  assert.deepEqual(existingFuliArgs(commentedOut), ['/srv.js', '--tool-profile', 'full']);
  assert.deepEqual(existingFuliArgs('broken=[\n[mcp_servers.other]\nargs=["--tool-profile","full"]\n'), []);
});

test('an unparseable file reads inline comments with quotes the way TOML does', () => {
  // SOL's repros: a quoted comment between flag and value, and a profile that only exists in a comment.
  const quotedComment = 'broken=[\n[mcp_servers.fuli]\nargs=["--tool-profile", # keep "full"\n"full"]\n';
  assert.deepEqual(existingFuliArgs(quotedComment), ['--tool-profile', 'full']);
  const commentedProfile = 'broken=[\n[mcp_servers.fuli]\ncommand="node" # old args=["--tool-profile","full"]\nargs=["/srv.js"]\n';
  assert.deepEqual(existingFuliArgs(commentedProfile), ['/srv.js']);
  // When the fuli table itself is broken, a # inside a string is not a comment.
  const brokenTable = 'broken=[\n[mcp_servers.fuli]\nurl = "http://x/#a"\nargs=["--tool-profile", "full" # "chat"\n';
  assert.deepEqual(existingFuliArgs(brokenTable), ['--tool-profile', 'full']);
});
