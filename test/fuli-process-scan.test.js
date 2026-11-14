import assert from 'node:assert/strict';
import test from 'node:test';

import { runningConsoles, runningMcpServers } from '../src/system/fuli-process-scan.js';

// The OS process list is a fake runner's synthetic output: no real process is listed.

const POSIX_CONFIG = '/synthetic/fuli-data/graph-runtime.json';
const WINDOWS_CONFIG = 'C:\\Synthetic\\FuliData\\graph-runtime.json';

const fakeRun = (stdout, calls = []) => async (command, args, options) => {
  calls.push({ command, args, options });
  return { stdout, stderr: '' };
};

test('ps rows that run this installation\'s MCP server are listed with their parent and start', async () => {
  const calls = [];
  const stdout = [
    '    1     0 Sun Nov  1 06:58:21 2026 /sbin/init',
    `  401   300 Tue Oct 27 10:15:30 2026 /usr/local/bin/node /opt/fuli/src/mcp-server.js --runtime-config ${POSIX_CONFIG}`,
    `  402   401 Tue Oct 27 10:15:31 2026 /usr/local/bin/node /opt/fuli/src/mcp-server.js --runtime-config ${POSIX_CONFIG} --source-application codex`,
    // Another installation's server, a worker and a one-shot call are not this installation's sessions.
    '  403   300 Tue Oct 27 10:15:32 2026 node /opt/fuli/src/mcp-server.js --runtime-config /other/graph-runtime.json',
    `  404   300 Tue Oct 27 10:15:33 2026 node /opt/fuli/src/mcp-server.js --worker --runtime-config ${POSIX_CONFIG}`,
    `  405   300 Tue Oct 27 10:15:34 2026 node /opt/fuli/src/mcp-server.js --runtime-config ${POSIX_CONFIG} --call recall`,
    `  406   300 Tue Oct 27 10:15:35 2026 node /opt/fuli/src/server.js --runtime-config ${POSIX_CONFIG}`,
    ''
  ].join('\n');
  const servers = await runningMcpServers(POSIX_CONFIG, { platform: 'darwin', run: fakeRun(stdout, calls) });
  assert.deepEqual(servers, [
    { pid: 401, parentPid: 300, startedAt: '2026-10-27T10:15:30.000Z' },
    { pid: 402, parentPid: 401, startedAt: '2026-10-27T10:15:31.000Z' }
  ]);
  assert.equal(calls[0].command, 'ps');
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.env.TZ, 'UTC');
  assert.equal(calls[0].options.env.LC_ALL, 'C');
});

test('Windows rows come from Get-CimInstance through powershell.exe -NoProfile, paths compared case-insensitively', async () => {
  const calls = [];
  const rows = [
    { pid: 5100, parentPid: 5000, startedAt: '2026-10-27T10:15:30.0000000Z',
      commandLine: `"C:\\Synthetic\\Fuli\\FuliNode.exe" src\\mcp-server.js --runtime-config ${WINDOWS_CONFIG.toUpperCase()}` },
    { pid: 5101, parentPid: 5100, startedAt: '2026-10-27T10:15:31.0000000Z',
      commandLine: `node.exe C:\\Synthetic\\Fuli\\src\\mcp-server.js --runtime-config ${WINDOWS_CONFIG}` },
    { pid: 5102, parentPid: 5000, startedAt: null, commandLine: null }
  ];
  const servers = await runningMcpServers(WINDOWS_CONFIG, { platform: 'win32', run: fakeRun(`\uFEFF${JSON.stringify(rows)}\r\n`, calls) });
  assert.deepEqual(servers, [
    { pid: 5100, parentPid: 5000, startedAt: '2026-10-27T10:15:30.000Z' },
    { pid: 5101, parentPid: 5100, startedAt: '2026-10-27T10:15:31.000Z' }
  ]);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.equal(calls[0].args[0], '-NoProfile');
  assert.equal(calls[0].options.timeout, 5000);
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-CimInstance Win32_Process/);

  // One process is a JSON object, none is an empty answer.
  assert.equal((await runningMcpServers(WINDOWS_CONFIG, { platform: 'win32', run: fakeRun(JSON.stringify(rows[1])) })).length, 1);
  assert.deepEqual(await runningMcpServers(WINDOWS_CONFIG, { platform: 'win32', run: fakeRun('') }), []);
});

test('a listing that fails or runs out of time answers null', async () => {
  const failed = async () => { throw new Error('ps timed out'); };
  assert.equal(await runningMcpServers(POSIX_CONFIG, { platform: 'linux', run: failed }), null);
  assert.equal(await runningMcpServers(WINDOWS_CONFIG, { platform: 'win32', run: failed }), null);
  assert.equal(await runningMcpServers(WINDOWS_CONFIG, { platform: 'win32', run: fakeRun('not json') }), null);
});

test('the consoles of this data directory are listed, recorded or not, and never an MCP server', async () => {
  const stdout = [
    `  406   300 Tue Oct 27 10:15:35 2026 /Applications/FULI.app/Contents/Resources/fuli/runtime/node/bin/node /Applications/FULI.app/Contents/Resources/fuli/src/server.js --runtime-config ${POSIX_CONFIG} --port 2727`,
    `  407   300 Tue Oct 27 10:15:36 2026 node /opt/fuli/src/mcp-server.js --runtime-config ${POSIX_CONFIG}`,
    '  408   300 Tue Oct 27 10:15:37 2026 node /opt/fuli/src/server.js --runtime-config /other/graph-runtime.json',
    ''
  ].join('\n');
  assert.deepEqual(await runningConsoles(POSIX_CONFIG, { platform: 'darwin', run: fakeRun(stdout) }),
    [{ pid: 406, parentPid: 300, startedAt: '2026-10-27T10:15:35.000Z' }]);
  const rows = [{ pid: 5200, parentPid: 5000, startedAt: null,
    commandLine: `"C:\\Synthetic\\Fuli\\versions\\a\\runtime\\node\\node.exe" C:\\Synthetic\\Fuli\\versions\\a\\src\\server.js --runtime-config ${WINDOWS_CONFIG}` }];
  assert.deepEqual(await runningConsoles(WINDOWS_CONFIG, { platform: 'win32', run: fakeRun(JSON.stringify(rows)) }),
    [{ pid: 5200, parentPid: 5000, startedAt: null }]);
});
