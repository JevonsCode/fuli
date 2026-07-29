import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function connectMcp(runtimeConfigPath, {
  serverPath = 'src/mcp-server.js'
} = {}) {
  const statusPath = join(mkdtempSync(join(tmpdir(), 'fuli-mcp-status-')), 'status.json');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'test-support/mcp-process-probe.js',
      statusPath,
      serverPath,
      '--runtime-config', runtimeConfigPath
    ],
    cwd: PROJECT_ROOT,
    stderr: 'pipe'
  });
  const stderr = [];
  transport.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  const transportClosed = new Promise((resolve) => { transport.onclose = resolve; });
  const client = new Client({ name: 'fuli-test', version: '1.0.0' });
  const connecting = client.connect(transport);
  const startingProbePid = transport.pid;
  try {
    await connecting;
  } catch (error) {
    error.cleanup = await cleanupFailedConnect({
      client,
      transport,
      transportClosed,
      statusPath,
      stderr,
      probePid: startingProbePid
    });
    throw error;
  }
  const probePid = transport.pid;
  let closePromise;
  return {
    client,
    close: () => closePromise ??= closeAndAssertExit({
      client,
      transportClosed,
      probePid,
      statusPath,
      stderr
    })
  };
}

async function cleanupFailedConnect({
  client, transport, transportClosed, statusPath, stderr, probePid
}) {
  await closeQuietly(client);
  await closeQuietly(transport);
  await transportClosed;
  const status = existsSync(statusPath)
    ? JSON.parse(readFileSync(statusPath, 'utf8'))
    : { code: null, signal: null, childPid: null, stderr: '' };
  assert.equal(processExists(probePid), false);
  assert.equal(processExists(status.childPid), false);
  return {
    probePid,
    childPid: status.childPid,
    stderr: stderr.join(''),
    status
  };
}

async function closeQuietly(closeable) {
  try {
    await closeable.close();
  } catch {
    // The failed startup may already have closed this endpoint.
  }
}

async function closeAndAssertExit({ client, transportClosed, probePid, statusPath, stderr }) {
  await client.close();
  await transportClosed;
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.deepEqual({ code: status.code, signal: status.signal, stderr: status.stderr }, {
    code: 0,
    signal: null,
    stderr: ''
  });
  assert.equal(stderr.join(''), '');
  assert.equal(processExists(probePid), false);
  assert.equal(processExists(status.childPid), false);
}

function processExists(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
