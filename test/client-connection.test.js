import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve('src/cli.js');

test('generic connection exports usable JSON without a client installation or model', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli connect '));
  try {
    const output = execFileSync(process.execPath, [cli, 'connect', '--data-dir', directory], { encoding: 'utf8' });
    const { fuli } = JSON.parse(output).mcpServers;
    assert.equal(fuli.command, process.execPath);
    assert.deepEqual(fuli.args.slice(1), ['--runtime-config', join(directory, 'graph-runtime.json'), '--source-application', 'other']);
    assert.equal(fuli.args[0], resolve('src/mcp-server.js'));
    assert.equal(fuli.env, undefined);
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('connection supports VS Code and server-only formats with an explicit runtime path', () => {
  const runtime = resolve('custom runtime.json');
  const run = (format) => JSON.parse(execFileSync(process.execPath, [cli, 'connect', '--format', format, '--runtime-config', runtime], { encoding: 'utf8' }));
  const server = run('server');
  assert.equal(server.type, 'stdio');
  assert.equal(server.args[2], runtime);
  assert.deepEqual(run('vscode'), { servers: { fuli: server } });
  assert.deepEqual(run('standard'), { mcpServers: { fuli: server } });
});

test('connection rejects ambiguous and unsupported options', () => {
  for (const args of [['--format', 'unknown'], ['--format'], ['--format', 'server', '--format', 'standard'], ['--data-dir', 'a', '--runtime-config', 'b'], ['--client', 'made-up']]) {
    const result = spawnSync(process.execPath, [cli, 'connect', ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('public MCP entry exposes the existing tool contract without configuration', () => {
  const output = execFileSync(process.execPath, [cli, 'mcp', '--tools'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.ok(JSON.parse(output).some(({ name }) => name === 'get_collaboration_preferences'));
});

test('exported connection completes MCP initialization and an authenticated read from an unknown client', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli generic MCP '));
  const requests = [];
  // A disposable Provider fixture exercises the real stdio transport without user data.
  const provider = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url.startsWith('/v1/personal-projects')
      ? [{ project_id: 'synthetic-project', profile: { name: 'Synthetic project' } }]
      : []));
  });
  const client = new Client({ name: 'unlisted-mcp-client', version: '1.0.0' });
  try {
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    writeFileSync(join(directory, 'graph-runtime.json'), JSON.stringify({
      version: 1,
      personal: { providerUrl: `http://127.0.0.1:${provider.address().port}`,
        accessToken: 'synthetic-access', principalId: 'synthetic-principal', spaceId: 'synthetic-space' },
      workspaces: []
    }));
    const { mcpServers: { fuli } } = JSON.parse(execFileSync(process.execPath,
      [cli, 'connect', '--data-dir', directory], { encoding: 'utf8' }));
    const transport = new StdioClientTransport({ command: fuli.command, args: fuli.args,
      cwd: directory, stderr: 'pipe' });
    const errors = [];
    transport.stderr.on('data', (chunk) => errors.push(chunk.toString()));
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'fuli');
    assert.ok((await client.listTools()).tools.some(({ name }) => name === 'get_collaboration_preferences'));
    const result = await client.callTool({ name: 'list_personal_projects',
      arguments: { personalSpaceId: 'synthetic-space' } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /synthetic-project/);
    assert.ok(requests.some(({ path, authorization }) => path.startsWith('/v1/personal-projects')
      && authorization === 'Bearer synthetic-access'));
    await client.close();
    assert.deepEqual(errors, []);
  } finally {
    await client.close();
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
