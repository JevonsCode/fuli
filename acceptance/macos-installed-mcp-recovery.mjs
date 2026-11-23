import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkLocalConsoleHealth } from '../src/local-runtime/console-health.js';
import { acquireConsoleStartLock, readConsoleAutostart } from '../src/local-runtime/console-autostart-record.js';
import { consoleProcessOwned } from '../src/local-runtime/unresponsive-console.js';

async function waitUntil(check, timeout, failure) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(failure);
}

export async function verifyInstalledMcpRecovery({ packageRoot, dataDir, home, env, port, version }) {
  assert.equal(process.platform, 'darwin');
  const root = await realpath(dirname(home));
  assert.equal(dirname(root), await realpath(tmpdir()));
  assert.match(basename(root), /^fuli-macos-smoke-/);
  assert.equal(dataDir, join(root, 'home', 'Library', 'Application Support', 'Fuli'));
  assert.equal(packageRoot, join(root, 'Applications', 'FULI.app', 'Contents', 'Resources', 'fuli'));
  const config = join(dataDir, 'graph-runtime.json');
  const stateFile = join(dataDir, 'graph-runtime-state.json');
  const before = JSON.parse(await readFile(stateFile, 'utf8'));
  const url = `http://127.0.0.1:${port}`;
  assert.equal(Number(new URL(before.url).port), port);
  assert.ok(Number.isInteger(before.pid) && before.pid > 1);
  assert.ok(await checkLocalConsoleHealth(url, before.pid, 3, 2500, version));

  const projectPath = join(home, 'candidate-test-project');
  await mkdir(projectPath, { recursive: true });
  const client = new Client({ name: 'release-candidate-check', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: join(packageRoot, 'runtime', 'node', 'bin', 'node'),
    args: [join(packageRoot, 'src', 'mcp-server.js'), '--runtime-config', config, '--source-application', 'codex', '--tool-profile', 'chat'],
    env: { ...env, FULI_DATA_DIR: dataDir }, cwd: packageRoot, stderr: 'ignore'
  });
  const calls = [
    { name: 'list_agent_interfaces', arguments: { toolName: 'read_diagnostic_events' } },
    { name: 'get_collaboration_preferences', arguments: {
      projectPath, taskPrompt: 'Verify the isolated release candidate', sessionId: '1ef931a0-2451-4091-9fe5-59170790e99a'
    } }
  ];
  try {
    await client.connect(transport);
    const clientPid = transport.pid;
    assert.ok(Number.isInteger(clientPid));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === calls[1].name));
    assert.ok((await client.callTool(calls[0])).structuredContent?.tools?.length);
    const starts = readConsoleAutostart(dataDir).starts.length;
    // Keep the two observations in the same outage. Releasing the ordinary start lock lets the installed MCP supervisor run again.
    const releaseStart = acquireConsoleStartLock(dataDir, { waitMs: 5000 });
    try {
      assert.equal(await consoleProcessOwned(before.pid, { graphRuntimeConfigPath: config }), 'owned');
      assert.ok(await checkLocalConsoleHealth(url, before.pid, 3, 2500, version));
      process.kill(before.pid, 'SIGTERM');
      await waitUntil(async () => !await checkLocalConsoleHealth(url, before.pid, 3, 600, version), 20_000,
        'The disposable console did not exit');
      for (const call of calls) {
        const result = await client.callTool(call);
        assert.equal(result.structuredContent?.error?.code, 'runtime_unavailable', call.name);
        const message = result.structuredContent.error.message;
        assert.match(message, /retry once/i);
        assert.doesNotMatch(message, /127\.0\.0\.1|https?:|\/Users\/|\/private\/|ECONNREFUSED/);
        assert.ok(message.length <= 240);
        assert.equal(result.structuredContent.taskContextToken, undefined);
      }
      console.log('PASS same installed MCP connection returned both bounded, redacted recovery messages');
    } finally {
      releaseStart();
    }

    await waitUntil(async () => {
      const after = await readFile(stateFile, 'utf8').then(JSON.parse).catch(() => null);
      return Number.isInteger(after?.pid) && after.pid !== before.pid &&
        await checkLocalConsoleHealth(url, after.pid, 3, 1500, version);
    }, 240_000, 'The installed MCP supervisor did not restore the disposable console');
    assert.ok(readConsoleAutostart(dataDir).starts.length > starts, 'An automatic start was recorded');
    const interfaces = await client.callTool(calls[0]);
    assert.ok(interfaces.structuredContent?.tools?.some(tool => tool.name === 'read_diagnostic_events'));
    const entry = await client.callTool(calls[1], undefined, { timeout: 120_000 });
    assert.ok(entry.structuredContent?.taskContextToken, 'Task entry issued a fresh token after recovery');
    assert.equal(transport.pid, clientPid);
    console.log('PASS the installed supervisor restarted the native console, then interface discovery and task entry succeeded on the same stdio connection');
  } finally {
    await client.close();
  }
}
