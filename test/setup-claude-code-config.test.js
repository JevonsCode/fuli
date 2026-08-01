import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectClaudeCode,
  disconnectClaudeCode
} from '../src/setup/claude-code-config.js';

const AGENT = Object.freeze({
  id: 'claude-code',
  label: 'Claude Code',
  configPath: 'fixtures/claude-config.json',
  settingsPath: 'fixtures/claude-settings.json'
});

const CONTEXT = Object.freeze({
  nodePath: 'synthetic-runtime/node',
  mcpServerPath: 'fixtures/mcp-server.js',
  runtimeConfigPath: 'fixtures/graph-runtime.json'
});

test('Claude Code connection keeps unrelated config and installs deterministic task hooks', () => {
  const writes = new Map();
  const result = connectClaudeCode(AGENT, CONTEXT, {
    readConfig: (filePath) => filePath === AGENT.configPath
      ? {
          theme: 'dark',
          mcpServers: { existing: { type: 'http', url: 'https://example.invalid/mcp' } }
        }
      : {
          permissions: { deny: ['Bash(rm *)'] },
          hooks: {
            Stop: [{
              hooks: [{ type: 'command', command: 'existing-stop-hook' }]
            }]
          }
        },
    writeConfig: (filePath, value) => writes.set(filePath, value)
  });

  assert.equal(result.status, 'connected');
  assert.equal(result.newTaskRequired, true);
  assert.deepEqual(writes.get(AGENT.configPath), {
    theme: 'dark',
    mcpServers: {
      existing: { type: 'http', url: 'https://example.invalid/mcp' },
      fuli: {
        type: 'stdio',
        command: CONTEXT.nodePath,
        args: [
          CONTEXT.mcpServerPath,
          '--runtime-config',
          CONTEXT.runtimeConfigPath
        ],
        alwaysLoad: true
      }
    }
  });

  const settings = writes.get(AGENT.settingsPath);
  assert.deepEqual(settings.permissions, { deny: ['Bash(rm *)'] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'existing-stop-hook');
  assert.deepEqual(settings.hooks.UserPromptSubmit.at(-1), {
    hooks: [{
      type: 'mcp_tool',
      server: 'fuli',
      tool: 'begin_task_context',
      input: {
        sessionId: '${session_id}',
        projectPath: '${cwd}',
        taskPrompt: '${prompt}'
      },
      timeout: 30,
      statusMessage: 'Loading Fuli task context'
    }]
  });
  assert.deepEqual(settings.hooks.Stop.at(-1), {
    hooks: [{
      type: 'mcp_tool',
      server: 'fuli',
      tool: 'verify_task_checkpoint',
      input: { sessionId: '${session_id}' },
      timeout: 30,
      statusMessage: 'Checking Fuli task checkpoint'
    }]
  });
});

test('Claude Code connection is idempotent and disconnect removes only Fuli entries', () => {
  const files = new Map([
    [AGENT.configPath, {}],
    [AGENT.settingsPath, {
      hooks: {
        UserPromptSubmit: [{
          hooks: [{ type: 'command', command: 'keep-prompt-hook' }]
        }]
      }
    }]
  ]);
  const io = {
    readConfig: (filePath) => structuredClone(files.get(filePath) ?? {}),
    writeConfig: (filePath, value) => files.set(filePath, structuredClone(value)),
    fileExists: (filePath) => files.has(filePath)
  };

  connectClaudeCode(AGENT, CONTEXT, io);
  const first = structuredClone(Object.fromEntries(files));
  connectClaudeCode(AGENT, CONTEXT, io);
  assert.deepEqual(Object.fromEntries(files), first);

  const result = disconnectClaudeCode(AGENT, io);
  assert.equal(result.status, 'disconnected');
  assert.equal(files.get(AGENT.configPath).mcpServers?.fuli, undefined);
  assert.deepEqual(files.get(AGENT.settingsPath).hooks.UserPromptSubmit, [{
    hooks: [{ type: 'command', command: 'keep-prompt-hook' }]
  }]);
  assert.equal(files.get(AGENT.settingsPath).hooks.Stop, undefined);
});

test('Claude Code config rejects malformed JSON object shapes before writing', () => {
  let written = false;
  assert.throws(() => connectClaudeCode(AGENT, CONTEXT, {
    readConfig: (filePath) => filePath === AGENT.configPath
      ? { mcpServers: [] }
      : {},
    writeConfig: () => { written = true; }
  }), /must be a JSON object/);
  assert.equal(written, false);
});
