import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseRemoteMcpOptions,
  readBearerToken,
  runRemoteMcpCommand
} from '../src/cli/remote-mcp-command.js';

test('remote MCP CLI requires an exact project and secret file and stays on loopback', () => {
  assert.deepEqual(parseRemoteMcpOptions([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', '/private/fuli-remote.token'
  ]), {
    personalProjectId: 'project-1',
    bearerTokenFile: '/private/fuli-remote.token',
    dataDir: null,
    port: 2728,
    host: '127.0.0.1',
    sourceApplication: 'claude',
    allowedOrigin: null,
    allowedHost: null,
    maxSessions: 8,
    sessionIdleTtlSeconds: 900
  });
  assert.throws(() => parseRemoteMcpOptions([]), /personal-project-id/);
  assert.throws(() => parseRemoteMcpOptions([
    '--personal-project-id', 'project-1'
  ]), /bearer-token-file/);
  assert.throws(() => parseRemoteMcpOptions([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', '/private/token',
    '--host', '0.0.0.0'
  ]), /loopback/);
  assert.deepEqual(parseRemoteMcpOptions([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', '/private/fuli-remote.token',
    '--allowed-origin', 'https://connector.example',
    '--allowed-host', 'connector.example',
    '--max-sessions', '24',
    '--session-idle-ttl-seconds', '120'
  ]), {
    personalProjectId: 'project-1',
    bearerTokenFile: '/private/fuli-remote.token',
    dataDir: null,
    port: 2728,
    host: '127.0.0.1',
    sourceApplication: 'claude',
    allowedOrigin: 'https://connector.example',
    allowedHost: 'connector.example',
    maxSessions: 24,
    sessionIdleTtlSeconds: 120
  });
  assert.throws(() => parseRemoteMcpOptions([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', '/private/token',
    '--max-sessions', '65'
  ]), /max-sessions/);
  assert.throws(() => parseRemoteMcpOptions([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', '/private/token',
    '--session-idle-ttl-seconds', '9'
  ]), /session-idle-ttl-seconds/);
  assert.throws(() => parseRemoteMcpOptions(['--typo', 'x']), /Unknown.*--typo/);
  assert.throws(() => parseRemoteMcpOptions([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', '/private/token',
    '--port', '3032',
    '--port', '3033'
  ]), /Duplicate --port/);
  for (const value of ['0x10', '1e3', ' 10 ']) {
    assert.throws(() => parseRemoteMcpOptions([
      '--personal-project-id', 'project-1',
      '--bearer-token-file', '/private/token',
      '--port', value
    ]), /--port must be an integer/);
  }
  assert.throws(() => parseRemoteMcpOptions([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', '/private/token',
    '--source-application', 'unsupported-client'
  ]), /source application/i);
});

test('remote MCP CLI validates the bound project and closes resources in order', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890\n', { mode: 0o600 });
  const events = [];
  const runtimePaths = [];
  const app = {
    config: { personal: { spaceId: 'space-1' } },
    listPersonalProjects: async ({ personalSpaceId }) => {
      assert.equal(personalSpaceId, 'space-1');
      return [{ project_id: 'project-1' }];
    },
    close: async () => events.push('app.close')
  };
  const leaseClient = {
    withGraphLease: async (owner, operation) => {
      events.push(`lease:${owner}`);
      return operation();
    },
    close: async () => events.push('lease.close')
  };
  const signalCounts = Object.fromEntries(
    ['SIGINT', 'SIGTERM'].map(signal => [signal, process.listenerCount(signal)])
  );
  const result = await runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath,
    '--data-dir', directory,
    '--host', 'localhost',
    '--port', '3032',
    '--source-application', 'claude_code',
    '--allowed-origin', 'https://connector.example',
    '--allowed-host', 'connector.example',
    '--max-sessions', '12',
    '--session-idle-ttl-seconds', '120'
  ], {
    openApplication: ({ runtimeConfigPath }) => {
      runtimePaths.push(runtimeConfigPath);
      return app;
    },
    createLeaseClient: ({ runtimeConfigPath }) => {
      runtimePaths.push(runtimeConfigPath);
      return leaseClient;
    },
    bindRuntimeLeaseAgentTools: (boundApp, boundLease) => {
      assert.equal(boundApp, app);
      assert.equal(boundLease, leaseClient);
      events.push('bind')
    },
    createRemoteServer: async (options) => {
      assert.equal(options.app, app);
      assert.equal(options.bearerToken, 'synthetic-remote-cli-token-1234567890');
      assert.equal(options.personalProjectId, 'project-1');
      assert.equal(options.personalSpaceId, 'space-1');
      assert.equal(options.sourceApplication, 'claude_code');
      assert.equal(options.host, 'localhost');
      assert.equal(options.port, 3032);
      assert.deepEqual(options.allowedOrigins, ['https://connector.example']);
      assert.deepEqual(options.allowedHosts, ['connector.example']);
      assert.equal(options.maxSessions, 12);
      assert.equal(options.sessionIdleTtlMs, 120_000);
      assert.equal(await options.withRuntimeLease('synthetic-tool', async () => 'leased'), 'leased');
      events.push('remote.start');
      return {
        url: 'http://127.0.0.1:3032',
        server: {},
        close: async () => events.push('remote.close')
      };
    },
    write: () => {}
  });
  assert.equal(runtimePaths.length, 2);
  assert.equal(runtimePaths[0], runtimePaths[1]);
  assert.match(runtimePaths[0], new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(events, [
    'bind', 'lease:remote-mcp-project-preflight', 'lease:synthetic-tool', 'remote.start'
  ]);
  await result.close();
  assert.deepEqual(events, [
    'bind', 'lease:remote-mcp-project-preflight', 'lease:synthetic-tool', 'remote.start',
    'remote.close', 'lease.close', 'app.close'
  ]);
  await result.close();
  assert.deepEqual(events, [
    'bind', 'lease:remote-mcp-project-preflight', 'lease:synthetic-tool', 'remote.start',
    'remote.close', 'lease.close', 'app.close'
  ]);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    assert.equal(process.listenerCount(signal), signalCounts[signal]);
  }
});

test('remote MCP CLI passes short-TTL and proxy options into the real HTTP server', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-real-server-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  const app = {
    config: { personal: { spaceId: 'space-1' } },
    listPersonalProjects: async () => [{ project_id: 'project-1' }],
    close: async () => {}
  };
  const result = await runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath,
    '--port', '0',
    '--max-sessions', '2',
    '--session-idle-ttl-seconds', '10',
    '--allowed-origin', 'https://connector.example',
    '--allowed-host', 'connector.example'
  ], {
    openApplication: () => app,
    createLeaseClient: () => ({
      withGraphLease: async (_owner, operation) => operation(),
      close: async () => {}
    }),
    bindRuntimeLeaseAgentTools: () => {},
    write: () => {}
  });
  t.after(() => result.close());
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  await result.close();
});

test('remote MCP CLI fails before listening when the project is not in the personal space', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-project-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  const events = [];
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'missing-project',
    '--bearer-token-file', tokenPath
  ], {
    openApplication: () => ({
      config: { personal: { spaceId: 'space-1' } },
      listPersonalProjects: async () => [{ project_id: 'project-1' }],
      close: async () => events.push('app.close')
    }),
    createLeaseClient: () => ({
      withGraphLease: async (_owner, operation) => operation(),
      close: () => {
        events.push('lease.close');
        throw new Error('synthetic synchronous lease close failure');
      }
    }),
    bindRuntimeLeaseAgentTools: () => {},
    createRemoteServer: async () => {
      events.push('remote.start');
      throw new Error('must not start')
    }
  }), /missing-project/);
  assert.deepEqual(events, ['lease.close', 'app.close']);
});

test('remote MCP CLI cleans up when post-construction banner output fails', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-banner-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  const signalTarget = new EventEmitter();
  const events = [];
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath
  ], {
    openApplication: () => ({
      config: { personal: { spaceId: 'space-1' } },
      listPersonalProjects: async () => [{ project_id: 'project-1' }],
      close: async () => events.push('app.close')
    }),
    createLeaseClient: () => ({
      withGraphLease: async (_owner, operation) => operation(),
      close: async () => events.push('lease.close')
    }),
    bindRuntimeLeaseAgentTools: () => {},
    createRemoteServer: async () => {
      events.push('remote.start');
      return {
        url: 'http://127.0.0.1:2728',
        server: {},
        close: async () => events.push('remote.close')
      };
    },
    signalTarget,
    write: () => { throw new Error('synthetic banner failure'); }
  }), /synthetic banner failure/);
  assert.deepEqual(events, [
    'remote.start', 'remote.close', 'lease.close', 'app.close'
  ]);
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});

test('remote MCP CLI preserves banner and cleanup failures in order', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-banner-close-errors-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  const signalTarget = new EventEmitter();
  const events = [];
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath
  ], {
    openApplication: () => ({
      config: { personal: { spaceId: 'space-1' } },
      listPersonalProjects: async () => [{ project_id: 'project-1' }],
      close: async () => events.push('app.close')
    }),
    createLeaseClient: () => ({
      withGraphLease: async (_owner, operation) => operation(),
      close: async () => {
        events.push('lease.close');
        throw new Error('synthetic lease close failure');
      }
    }),
    bindRuntimeLeaseAgentTools: () => {},
    createRemoteServer: async () => ({
      url: 'http://127.0.0.1:2728',
      server: {},
      close: async () => {
        events.push('remote.close');
        throw new Error('synthetic remote close failure');
      }
    }),
    signalTarget,
    write: () => { throw new Error('synthetic banner failure'); }
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ message }) => message), [
      'synthetic banner failure',
      'synthetic remote close failure',
      'synthetic lease close failure'
    ]);
    return true;
  });
  assert.deepEqual(events, ['remote.close', 'lease.close', 'app.close']);
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});

test('remote MCP CLI closes the application when lease construction fails', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-lease-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  let appClosed = false;
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath
  ], {
    openApplication: () => ({
      config: { personal: { spaceId: 'space-1' } },
      close: async () => { appClosed = true; }
    }),
    createLeaseClient: () => { throw new Error('synthetic lease failure'); }
  }), /synthetic lease failure/);
  assert.equal(appClosed, true);
});

test('remote MCP CLI rejects a group-readable bearer token before opening the app', async (t) => {
  if (process.platform === 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-mode-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  chmodSync(tokenPath, 0o640);
  let opened = false;
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath
  ], { openApplication: () => { opened = true; } }), /chmod 600/);
  assert.equal(opened, false);
});

test('remote MCP CLI rejects symbolic-link and oversized bearer-token files', async (t) => {
  if (process.platform === 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-secret-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const targetPath = join(directory, 'target');
  const linkPath = join(directory, 'link');
  writeFileSync(targetPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  symlinkSync(targetPath, linkPath);
  const oversizedPath = join(directory, 'oversized');
  writeFileSync(oversizedPath, 'x'.repeat(4097), { mode: 0o600 });

  let opened = false;
  const dependencies = { openApplication: () => { opened = true; } };
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', linkPath
  ], dependencies), /symbolic link/);
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', oversizedPath
  ], dependencies), /4096 bytes/);
  assert.equal(opened, false);
});

test('remote MCP CLI maps EMLINK token-open errors to the symlink diagnostic', () => {
  const error = Object.assign(new Error('synthetic EMLINK'), { code: 'EMLINK' });
  assert.throws(() => readBearerToken('/synthetic/token', {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
    openSync: () => { throw error; }
  }), /symbolic link/);
});

test('remote MCP CLI rejects malformed and non-file bearer-token paths before opening', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-token-shape-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shortPath = join(directory, 'short');
  const spacedPath = join(directory, 'spaced');
  writeFileSync(shortPath, 'too-short', { mode: 0o600 });
  writeFileSync(spacedPath, 'synthetic remote cli token 1234567890', { mode: 0o600 });
  let opened = false;
  const dependencies = { openApplication: () => { opened = true; } };
  for (const tokenPath of [shortPath, spacedPath]) {
    await assert.rejects(() => runRemoteMcpCommand([
      '--personal-project-id', 'project-1',
      '--bearer-token-file', tokenPath
    ], dependencies), /24 to 512 visible ASCII/);
  }
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', directory
  ], dependencies), /regular file/);
  assert.equal(opened, false);
});

test('remote MCP CLI rejects a FIFO bearer-token path without blocking', {
  timeout: 2_000
}, async (t) => {
  if (process.platform === 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-fifo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fifoPath = join(directory, 'token.fifo');
  try {
    execFileSync('mkfifo', [fifoPath]);
  } catch {
    return;
  }
  await assert.rejects(() => runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', fifoPath
  ]), /regular file/);
});

test('remote MCP CLI reports signal shutdown failures and always removes listeners', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-signal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  const signalTarget = new EventEmitter();
  const events = [];
  const errors = [];
  const exitCodes = [];
  const app = {
    config: { personal: { spaceId: 'space-1' } },
    listPersonalProjects: async () => [{ project_id: 'project-1' }],
    close: async () => events.push('app.close')
  };
  const result = await runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath
  ], {
    openApplication: () => app,
    createLeaseClient: () => ({
      withGraphLease: async (_owner, operation) => operation(),
      close: async () => events.push('lease.close')
    }),
    bindRuntimeLeaseAgentTools: () => {},
    createRemoteServer: async (options) => {
      assert.deepEqual(options.allowedOrigins, []);
      assert.deepEqual(options.allowedHosts, []);
      return {
        url: 'http://127.0.0.1:2728',
        server: {},
        close: async () => {
          events.push('remote.close');
          throw new Error('synthetic remote shutdown failure');
        }
      };
    },
    signalTarget,
    reportError: error => errors.push(error.message),
    setExitCode: code => exitCodes.push(code),
    write: () => {}
  });
  assert.equal(signalTarget.listenerCount('SIGINT'), 1);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 1);
  signalTarget.emit('SIGTERM');
  await assert.rejects(result.close(), /synthetic remote shutdown failure/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['remote.close', 'lease.close', 'app.close']);
  assert.deepEqual(errors, ['synthetic remote shutdown failure']);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});

test('remote MCP CLI preserves every simultaneous shutdown failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-remote-cli-close-errors-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, 'synthetic-remote-cli-token-1234567890', { mode: 0o600 });
  const events = [];
  const signalTarget = new EventEmitter();
  const errorWrites = [];
  const exitCodes = [];
  const result = await runRemoteMcpCommand([
    '--personal-project-id', 'project-1',
    '--bearer-token-file', tokenPath
  ], {
    openApplication: () => ({
      config: { personal: { spaceId: 'space-1' } },
      listPersonalProjects: async () => [{ project_id: 'project-1' }],
      close: async () => {
        events.push('app.close');
        throw new Error('synthetic app close failure');
      }
    }),
    createLeaseClient: () => ({
      withGraphLease: async (_owner, operation) => operation(),
      close: async () => {
        events.push('lease.close');
        throw new Error('synthetic lease close failure');
      }
    }),
    bindRuntimeLeaseAgentTools: () => {},
    createRemoteServer: async () => ({
      url: 'http://127.0.0.1:2728',
      server: {},
      close: async () => {
        events.push('remote.close');
        throw new Error('synthetic remote close failure');
      }
    }),
    signalTarget,
    writeError: value => errorWrites.push(value),
    setExitCode: code => exitCodes.push(code),
    write: () => {}
  });
  signalTarget.emit('SIGTERM');
  await assert.rejects(result.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ message }) => message), [
      'synthetic remote close failure',
      'synthetic lease close failure',
      'synthetic app close failure'
    ]);
    return true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['remote.close', 'lease.close', 'app.close']);
  assert.equal(exitCodes[0], 1);
  assert.equal(errorWrites.length, 1);
  for (const message of [
    'synthetic remote close failure',
    'synthetic lease close failure',
    'synthetic app close failure'
  ]) {
    assert.match(errorWrites[0], new RegExp(message));
  }
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});
