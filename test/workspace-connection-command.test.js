import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  runWorkspaceConnectionCommand,
  WorkspaceConnectionError
} from '../src/cli/workspace-connection-command.js';

const TOKEN = 'fws_admin_unit-test-token-abcdefghijklmnopqrstuvwxyz';
const NODE = process.execPath;
const CLI = resolve('src/cli.js');

test('CLI help lists the workspace connection command', () => {
  const help = execFileSync(NODE, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /connect-workspace --url URL --token-file FILE/);

  const commandHelp = execFileSync(NODE, [CLI, 'connect-workspace', '--help'], {
    encoding: 'utf8'
  });
  assert.match(commandHelp, /Usage: fuli connect-workspace/);
});

test('connect-workspace validates the service and securely upserts runtime configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-workspace-connect-'));
  const tokenPath = join(directory, 'workspace-token');
  const configPath = join(directory, 'graph-runtime.json');
  writeFileSync(tokenPath, `${TOKEN}\n`, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    personal: { providerUrl: 'http://127.0.0.1:9400', accessToken: 'personal', principalId: 'me' },
    workspaces: [
      { providerUrl: 'https://other.example', accessToken: 'keep', principalId: 'other' },
      {
        protocol: 'legacy',
        providerUrl: 'http://127.0.0.1:8789/',
        accessToken: 'replace',
        principalId: 'replace',
        label: 'Local workspace'
      },
      { providerUrl: 'http://127.0.0.1:8789', accessToken: 'duplicate', principalId: 'duplicate' }
    ],
    untouched: { enabled: true }
  }), { encoding: 'utf8', mode: 0o600 });

  const requests = [];
  const output = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (new URL(url).pathname === '/.well-known/fuli-workspace') {
      return jsonResponse({
        protocolVersion: '1',
        provider: { id: 'workspace-provider' },
        endpoints: { authSession: '/v1/auth/session' }
      });
    }
    return jsonResponse({
      authenticated: true,
      principal: { id: 'principal-from-session', displayName: 'Test principal' },
      grant: { role: 'admin', workspaceIds: '*' }
    });
  };

  const result = await runWorkspaceConnectionCommand([
    '--url', 'http://127.0.0.1:8789/',
    '--token-file', tokenPath,
    '--data-dir', directory
  ], { fetch, write: (value) => output.push(value) });

  assert.deepEqual(result, {
    status: 'configured',
    providerUrl: 'http://127.0.0.1:8789',
    restartRequired: true
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://127.0.0.1:8789/.well-known/fuli-workspace');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(requests[1].url, 'http://127.0.0.1:8789/v1/auth/session');
  assert.equal(requests[1].init.headers.authorization, `Bearer ${TOKEN}`);

  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved.untouched, { enabled: true });
  assert.equal(saved.workspaces.length, 2);
  assert.equal(saved.workspaces[0].providerUrl, 'https://other.example');
  assert.deepEqual(saved.workspaces[1], {
    protocol: 'fuli-workspace-v1',
    providerUrl: 'http://127.0.0.1:8789',
    providerId: 'workspace-provider',
    accessToken: TOKEN,
    principalId: 'principal-from-session',
    role: 'admin',
    workspaceIds: '*',
    label: 'Local workspace'
  });
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const visibleOutput = output.join('\n');
  assert.match(visibleOutput, /Restart required/);
  assert.doesNotMatch(visibleOutput, new RegExp(TOKEN));
  assert.doesNotMatch(visibleOutput, /principal-from-session/);
  assert.doesNotMatch(visibleOutput, new RegExp(escapePattern(tokenPath)));
});

test('connect-workspace accepts the legacy top-level role session shape', async () => {
  const fixture = secureFixture();
  const responses = [
    jsonResponse({ protocolVersion: 1, provider: { id: 'provider-a' } }),
    jsonResponse({
      authenticated: true,
      principal: { id: 'principal-a' },
      role: 'reader',
      workspaceIds: ['workspace-a']
    })
  ];
  let written;
  await runWorkspaceConnectionCommand(fixture.args, {
    fetch: async () => responses.shift(),
    readConfig: () => fixture.config,
    writeConfig: (_path, value) => { written = value; },
    secureFile: () => {},
    write: () => {}
  });

  assert.equal(written.workspaces[0].role, 'reader');
  assert.deepEqual(written.workspaces[0].workspaceIds, ['workspace-a']);
});

test('connect-workspace rejects unsafe provider URLs before reading credentials', async () => {
  const unsafe = [
    'http://public.example',
    'https://user:password@public.example',
    'https://public.example/path',
    'https://public.example?mode=test',
    'https://public.example#fragment'
  ];
  for (const url of unsafe) {
    await assert.rejects(
      runWorkspaceConnectionCommand(['--url', url, '--token-file', 'unused']),
      WorkspaceConnectionError
    );
  }

  await assert.rejects(
    runWorkspaceConnectionCommand([TOKEN]),
    (error) => error instanceof WorkspaceConnectionError && !error.message.includes(TOKEN)
  );
});

test('connect-workspace rejects redirects and cross-origin authentication endpoints', async () => {
  const fixture = secureFixture();
  let writes = 0;
  await assert.rejects(
    runWorkspaceConnectionCommand(fixture.args, {
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://unexpected.example/discovery' }
      }),
      writeConfig: () => { writes += 1; },
      write: () => {}
    }),
    /redirects are not allowed/
  );

  await assert.rejects(
    runWorkspaceConnectionCommand(fixture.args, {
      fetch: async () => jsonResponse({
        protocolVersion: '1',
        provider: { id: 'provider-a' },
        endpoints: { authSession: 'https://unexpected.example/v1/auth/session' }
      }),
      writeConfig: () => { writes += 1; },
      write: () => {}
    }),
    /cross-origin authentication endpoint/
  );
  assert.equal(writes, 0);
});

test('connect-workspace rejects symlinks and overly broad token permissions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-workspace-token-'));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, TOKEN, { encoding: 'utf8', mode: 0o600 });
  const linkPath = join(directory, 'token-link');
  symlinkSync(tokenPath, linkPath);

  await assert.rejects(
    runWorkspaceConnectionCommand([
      '--url', 'http://127.0.0.1:8789', '--token-file', linkPath
    ]),
    /regular file, not a symlink/
  );

  if (process.platform === 'win32') {
    t.skip('POSIX permission bits are not available on Windows');
    return;
  }
  chmodSync(tokenPath, 0o640);
  await assert.rejects(
    runWorkspaceConnectionCommand([
      '--url', 'http://127.0.0.1:8789', '--token-file', tokenPath
    ]),
    /must not be readable by group or other users/
  );
});

function secureFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-workspace-fixture-'));
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, TOKEN, { encoding: 'utf8', mode: 0o600 });
  return {
    args: ['--url', 'http://127.0.0.1:8789', '--token-file', tokenPath],
    config: {
      version: 1,
      personal: { providerUrl: 'http://127.0.0.1:9400' },
      workspaces: []
    }
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
