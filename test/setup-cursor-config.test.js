import assert from 'node:assert/strict';
import test from 'node:test';

import { connectCursor, disconnectCursor } from '../src/setup/cursor-config.js';

const AGENT = Object.freeze({
  id: 'cursor',
  label: 'Cursor',
  configPath: 'C:/Users/Test/.cursor/mcp.json'
});

const CONTEXT = Object.freeze({
  nodePath: 'C:/Program Files/nodejs/node.exe',
  mcpServerPath: 'C:/Fuli/src/mcp-server.js',
  runtimeConfigPath: 'C:/Users/Test/Fuli/graph-runtime.json'
});

test('Cursor config preserves existing servers and registers Fuli', () => {
  let write = null;
  const result = connectCursor(AGENT, CONTEXT, {
    readConfig: () => ({
      version: 1,
      mcpServers: { existing: { command: 'existing-server' } }
    }),
    writeConfig: (filePath, value) => { write = { filePath, value }; }
  });

  assert.deepEqual(result, { id: 'cursor', label: 'Cursor', status: 'connected' });
  assert.equal(write.filePath, AGENT.configPath);
  assert.deepEqual(write.value, {
    version: 1,
    mcpServers: {
      existing: { command: 'existing-server' },
      fuli: {
        command: CONTEXT.nodePath,
        args: [
          CONTEXT.mcpServerPath,
          '--runtime-config',
          CONTEXT.runtimeConfigPath,
          '--source-application',
          'cursor'
        ]
      }
    }
  });
});

test('Cursor config rejects malformed top-level and mcpServers values without writing', () => {
  for (const current of [[], { mcpServers: [] }]) {
    let written = false;
    assert.throws(() => connectCursor(AGENT, CONTEXT, {
      readConfig: () => current,
      writeConfig: () => { written = true; }
    }), /must be a JSON object/);
    assert.equal(written, false);
  }
});

test('Cursor disconnect removes only the Fuli server', () => {
  let write = null;
  const result = disconnectCursor(AGENT, {
    fileExists: () => true,
    readConfig: () => ({
      version: 1,
      mcpServers: {
        existing: { command: 'existing-server' },
        fuli: { command: 'node' }
      }
    }),
    writeConfig: (filePath, value) => { write = { filePath, value }; }
  });

  assert.equal(result.status, 'disconnected');
  assert.deepEqual(write.value, {
    version: 1,
    mcpServers: { existing: { command: 'existing-server' } }
  });
});

test('Cursor connector installs lifecycle hooks and preserves user hooks on disconnect', () => {
  const agent = { ...AGENT, hooksPath: 'C:/Users/Test/.cursor/hooks.json' };
  const originalHooks = { version: 1, hooks: { stop: [{ command: 'user-hook' }] } };
  const files = new Map([
    [agent.configPath, { mcpServers: { existing: { command: 'existing-server' } } }],
    [agent.hooksPath, originalHooks]
  ]);
  const options = {
    fileExists: path => files.has(path),
    readConfig: path => files.get(path),
    writeConfig: (path, value) => files.set(path, value)
  };
  assert.equal(connectCursor(agent, CONTEXT, options).newTaskRequired, true);
  assert.equal(files.get(agent.hooksPath).hooks.stop.length, 2);
  assert.equal(connectCursor(agent, CONTEXT, options).newTaskRequired, false);
  files.delete(agent.configPath);
  assert.equal(disconnectCursor(agent, options).status, 'disconnected');
  assert.deepEqual(files.get(agent.hooksPath), originalHooks);
});

test('Cursor reload status includes registration changes and avoids idempotent rewrites', () => {
  const agent = { ...AGENT, hooksPath: 'C:/Users/Test/.cursor/hooks.json' };
  const files = new Map([
    [agent.configPath, {}],
    [agent.hooksPath, {}]
  ]);
  const writes = [];
  const options = {
    fileExists: path => files.has(path),
    readConfig: path => structuredClone(files.get(path) ?? {}),
    writeConfig: (path, value) => {
      writes.push(path);
      files.set(path, structuredClone(value));
    }
  };

  connectCursor(agent, CONTEXT, options);
  files.get(agent.configPath).mcpServers.fuli.command = 'old-runtime';
  writes.length = 0;

  assert.equal(connectCursor(agent, CONTEXT, options).newTaskRequired, true);
  assert.deepEqual(writes, [agent.configPath]);
  writes.length = 0;
  assert.equal(connectCursor(agent, CONTEXT, options).newTaskRequired, false);
  assert.deepEqual(writes, []);
});

test('invalid Cursor lifecycle config cannot cause a partial MCP config write', () => {
  const agent = { ...AGENT, hooksPath: 'C:/Users/Test/.cursor/hooks.json' };
  for (const invalid of [null, false, '', [], { version: 2 }]) {
    let writes = 0;
    assert.throws(() => connectCursor(agent, CONTEXT, {
      readConfig: path => path === agent.hooksPath ? invalid : {},
      writeConfig: () => { writes += 1; }
    }), /hooks config/);
    assert.equal(writes, 0);
  }
});
