import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ApplicationError } from '../src/app/application-error.js';
import { listAgentTools } from '../src/agent-tools.js';
import { annotationsFor } from '../src/mcp/tool-annotations.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { errorToolResult } from '../src/mcp/tool-result.js';
import { createCloseOnce } from '../src/mcp/runtime.js';

test('--tools lists the Graphiti registry without requiring a runtime config', () => {
  const output = execFileSync(process.execPath, ['src/mcp-server.js', '--tools'], {
    encoding: 'utf8'
  });
  assert.deepEqual(JSON.parse(output), listAgentTools());
});

const workerDescriptor = () => ({ runId: 'synthetic-cli-run', personalProjectId: 'synthetic-project',
  capability: 'synthetic-worker-capability-never-log-1234', projectPath: '/host/project',
  taskPrompt: 'Bounded synthetic host brief', toolNames: ['verify_task_checkpoint'] });

test('worker CLI rejects incompatible arguments and invalid descriptors before opening an application', () => {
  const descriptor = workerDescriptor();
  const env = { ...process.env, FULI_GRAPH_RUNTIME_CONFIG: resolve('missing-synthetic-worker-runtime.json'),
    FULI_WORKER_DESCRIPTOR: JSON.stringify(descriptor) };
  function rejected(args, raw = env.FULI_WORKER_DESCRIPTOR) {
    const child = spawnSync(process.execPath, ['src/cli.js', 'mcp', '--worker', ...args], {
      env: { ...env, FULI_WORKER_DESCRIPTOR: raw }, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.trim(), 'MCP server failed to start');
    assert.equal(child.stderr.includes(descriptor.capability), false);
  }
  for (const args of [['--tools'], ['--call', 'get_collaboration_preferences'], ['--input', '{}'],
    ['--tool-profile', 'full'], ['--source-application', 'codex'], ['--worker'], ['--unknown'],
    ['unexpected'], ['--runtime-config'], ['--runtime-config', '--tools'],
    ['--runtime-config', 'one', '--runtime-config', 'two'], ['--worker=1']]) rejected(args);
  for (const raw of ['', 'not-json ' + descriptor.capability, 'null', '[]',
    JSON.stringify({ ...descriptor, taskContextToken: descriptor.capability }),
    JSON.stringify({ ...descriptor, capability: 'short' }),
    JSON.stringify({ ...descriptor, capability: descriptor.capability.repeat(4) }),
    JSON.stringify({ ...descriptor, taskPrompt: 42 }),
    JSON.stringify({ ...descriptor, toolNames: ['message_agent'] })]) rejected([], raw);
  const help = spawnSync(process.execPath, ['src/cli.js', 'mcp', '--worker', '--help'], {
    env: { ...env, FULI_WORKER_DESCRIPTOR: 'invalid' }, encoding: 'utf8'
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /mcp --worker/);
  assert.equal(help.stderr, '');
  const normal = spawnSync(process.execPath, ['src/cli.js', 'mcp', '--tools'], {
    env: { ...env, FULI_WORKER_DESCRIPTOR: 'invalid' }, encoding: 'utf8'
  });
  assert.equal(normal.status, 0);
  assert.deepEqual(JSON.parse(normal.stdout), listAgentTools());
});

test('worker descriptor decoding bounds UTF-8 bytes before JSON parsing', async () => {
  const { decodeWorkerDescriptor } = await import('../src/graphiti/worker-descriptor.js');
  const raw = JSON.stringify({ ...workerDescriptor(), taskPrompt: '临时 🙂' });
  const padded = raw + ' '.repeat(64 * 1024 - Buffer.byteLength(raw));
  assert.deepEqual(decodeWorkerDescriptor(padded), JSON.parse(raw));
  assert.throws(() => decodeWorkerDescriptor(padded + ' '), /Worker descriptor.*size/);
  assert.throws(() => decodeWorkerDescriptor(undefined), /Worker descriptor/);
});

test('real CLI worker initializes offline from a package path with spaces and ignores parent mode environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli worker CLI '));
  const packagePath = join(directory, 'candidate package with spaces');
  await symlink(resolve('.'), packagePath, 'junction');
  const runtimeDirectory = join(directory, 'runtime with spaces');
  await mkdir(runtimeDirectory);
  const runtimeConfigPath = join(runtimeDirectory, 'graph-runtime.json');
  let providerCalls = 0;
  const provider = createServer((_request, response) => { providerCalls++; response.writeHead(503).end(); });
  await new Promise(ready => provider.listen(0, '127.0.0.1', ready));
  await writeFile(runtimeConfigPath, JSON.stringify({ version: 1, workspaces: [], personal: {
    providerUrl: `http://127.0.0.1:${provider.address().port}`, accessToken: 'synthetic-cli-provider-token',
    principalId: 'synthetic-cli-host', spaceId: 'synthetic-cli-space'
  } }));
  try {
    for (const worker of [true, false]) {
      const client = new Client({ name: 'worker-cli-offline', version: '1' });
      const descriptor = { ...workerDescriptor(), toolNames: [] };
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [join(packagePath, 'src', 'cli.js'), 'mcp', ...(worker ? ['--worker'] : ['--tool-profile', 'chat']),
          '--runtime-config', runtimeConfigPath], stderr: 'pipe',
        env: { ...process.env, CODEX_THREAD_ID: '019fc6ed-02a5-7832-8821-68e3b03e7ce3',
          FULI_WORKER_DESCRIPTOR: JSON.stringify(descriptor) } });
      let stderr = '';
      transport.stderr.on('data', chunk => { stderr += chunk; });
      try {
        await client.connect(transport);
        const tools = (await client.listTools()).tools.map(item => item.name);
        if (worker) assert.deepEqual(tools, []);
        else assert.ok(tools.includes('message_agent'), 'ordinary MCP must ignore worker environment');
        assert.equal(providerCalls, 0);
      } finally {
        await client.close();
        assert.equal(stderr.includes(descriptor.capability), false);
      }
    }
  } finally {
    await new Promise(done => provider.close(done));
    await unlink(packagePath);
    await rm(directory, { recursive: true, force: true });
  }
});

test('strict Zod conversion preserves nested Graphiti arrays and required fields', () => {
  for (const definition of listAgentTools()) {
    const converted = jsonSchemaToZod(definition.inputSchema);
    const valid = sampleValue(definition.inputSchema);
    assert.equal(converted.safeParse(valid).success, true, definition.name);
    assert.equal(converted.safeParse({ ...valid, unexpected: true }).success, false,
      `${definition.name} must reject additional properties`);
    for (const required of definition.inputSchema.required ?? []) {
      const missing = { ...valid };
      delete missing[required];
      assert.equal(converted.safeParse(missing).success, false,
        `${definition.name}.${required} must remain required`);
    }
  }
});

test('MCP annotations distinguish reads, writes, and review decisions', () => {
  for (const { name } of listAgentTools()) {
    assert.deepEqual(Object.keys(annotationsFor(name)).sort(), [
      'destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'
    ]);
  }
  assert.equal(annotationsFor('get_collaboration_preferences').readOnlyHint, false);
  assert.equal(annotationsFor('search_knowledge_graph').readOnlyHint, false);
  assert.equal(annotationsFor('get_knowledge_graph').readOnlyHint, false);
  assert.equal(annotationsFor('search_human_knowledge_changes').readOnlyHint, false);
  assert.equal(annotationsFor('capture_session_knowledge').readOnlyHint, false);
  assert.equal(annotationsFor('capture_session_knowledge').openWorldHint, true);
  assert.equal(annotationsFor('review_project_proposal').destructiveHint, true);
});

test('controlled Provider validation errors keep the actionable reason', () => {
  const result = errorToolResult(new ApplicationError(
    'provider_error',
    'body.episode.entities[0]: non-known-known knowledge requires a reasoning summary'
  ));

  assert.equal(result.structuredContent.error.message,
    'body.episode.entities[0]: ' +
    'non-known-known knowledge requires a reasoning summary');
  assert.equal(result.isError, true);
});

test('close-once runtime closes MCP before the graph facade exactly once', async () => {
  const calls = [];
  const close = createCloseOnce({
    closeServer: async () => calls.push('server'),
    closeApplication: async () => calls.push('graph')
  });
  await Promise.all([close(), close(), close()]);
  assert.deepEqual(calls, ['server', 'graph']);
});

function sampleValue(schema) {
  if (schema.enum) return schema.enum[0];
  if (Array.isArray(schema.type)) return schema.type.includes('string') ? 'value' : null;
  if (schema.type === 'string') {
    return schema.format === 'date-time' ? '2026-07-21T10:00:00.000Z' :
      schema.pattern === '^https?://\\S+$' ? 'https://provider.example.test' :
      schema.pattern === '^[a-f0-9]{64}$' ? 'a'.repeat(64) :
      schema.pattern === '^[A-Z][A-Z0-9_]*$' ? 'RELATES_TO' :
        schema.pattern === '^[A-Za-z][A-Za-z0-9_]*$' ? 'Entity' :
          schema.pattern === '^personal-global-[a-f0-9]{20}$' ?
            'personal-global-0123456789abcdef0123' :
            schema.pattern === '^v1:[a-f0-9]{24}$' ?
              'v1:0123456789abcdef01234567' :
          schema.pattern === '^(entity|relationship):.+' ? 'entity:valid-value' :
          'valid-value';
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer') return Math.max(1, schema.minimum ?? 1);
  if (schema.type === 'number') return schema.minimum ?? 0;
  if (schema.type === 'array') {
    const count = schema.minItems ?? 0;
    return Array.from({ length: count }, () => sampleValue(schema.items));
  }
  if (schema.type === 'object') {
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      .filter(([name]) => (schema.required ?? []).includes(name))
      .map(([name, value]) => [name, sampleValue(value)]));
  }
  throw new Error(`No sample for ${schema.type}`);
}
