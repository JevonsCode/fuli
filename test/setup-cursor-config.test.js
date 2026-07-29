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
          CONTEXT.runtimeConfigPath
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
