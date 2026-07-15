import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { ApplicationError, ApplicationErrorCode } from '../src/app/application-error.js';
import { createApplication } from '../src/app/create-application.js';
import { listAgentTools } from '../src/agent-tools.js';
import { SpaceKind } from '../src/models.js';
import { annotationsFor } from '../src/mcp/tool-annotations.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';
import { errorToolResult } from '../src/mcp/tool-result.js';
import {
  createCloseOnce,
  createQuietCloser,
  createServerOrClose,
  initializeLocalSpaces
} from '../src/mcp/runtime.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const NODE = process.execPath;
const execFileAsync = promisify(execFile);

test('MCP server uses only public SDK request-handler extension points', () => {
  const source = readFileSync(new URL('../src/mcp/create-mcp-server.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /createToolError|_registeredTools|_[a-zA-Z]+Tools/);
  assert.match(source, /server\.server\.setRequestHandler/);
});

test('--tools lists the shared registry without opening the requested database', () => {
  const impossibleDb = join(mkdtempSync(join(tmpdir(), 'fuli-mcp-tools-')), 'missing', 'db.sqlite');
  const output = execFileSync(NODE, ['src/mcp-server.js', '--tools', '--db', impossibleDb], {
    encoding: 'utf8'
  });
  const tools = JSON.parse(output);

  assert.deepEqual(tools, listAgentTools());
  assert.equal(tools.length, 16);
});

test('--call uses SQLite, bootstraps a fresh personal space, and closes cleanly', () => {
  const dbPath = tempDb('fuli-mcp-call-');
  const output = execFileSync(NODE, [
    'src/mcp-server.js', '--db', dbPath, '--personal-space', '我',
    '--call', 'remember_user_fact', '--input', JSON.stringify({
      predicate: 'prefers_language',
      value: 'JavaScript',
      sourceText: '我熟悉 JavaScript'
    })
  ], { encoding: 'utf8' });
  const result = JSON.parse(output);

  assert.equal(result.fact.status, 'confirmed');
  assert.equal(result.fact.sourceEpisodeId, result.episode.id);

  const store = new SqliteStore(dbPath);
  assert.equal(store.listFacts().length, 1);
  store.close();
});

test('--call shares database and personal-space environment options', () => {
  const dbPath = tempDb('fuli-mcp-env-');
  const output = execFileSync(NODE, [
    'src/mcp-server.js', '--call', 'get_user_lens',
    '--input', '{"task":"test","budget":2000}'
  ], {
    encoding: 'utf8',
    env: { ...process.env, FULI_DB_PATH: dbPath, FULI_PERSONAL_SPACE: 'Jevons' }
  });

  assert.equal(Array.isArray(JSON.parse(output).facts), true);
  const store = new SqliteStore(dbPath);
  assert.equal(store.findSpaceByName('Jevons').kind, 'personal');
  store.close();
});

test('fresh SQLite bootstrap is safe across eight concurrent MCP calls', async () => {
  for (let round = 0; round < 3; round += 1) {
    const dbPath = tempDb(`fuli-mcp-race-${round}-`);
    const calls = Array.from({ length: 8 }, (_, index) => execFileAsync(NODE, [
      'src/mcp-server.js', '--db', dbPath, '--personal-space', '我',
      '--call', 'remember_user_fact', '--input', JSON.stringify({
        predicate: `parallel_fact_${index}`,
        value: `value-${round}-${index}`,
        sourceText: `并发事实 ${round}-${index}`
      })
    ], { encoding: 'utf8' }));

    const results = await Promise.all(calls);
    assert.equal(results.every(({ stderr }) => stderr === ''), true);
    assert.equal(results.every(({ stdout }) => JSON.parse(stdout).fact.status === 'confirmed'), true);

    const store = new SqliteStore(dbPath);
    const spaces = store.listSpaces();
    assert.equal(spaces.filter(({ name, kind }) => name === '我' && kind === 'personal').length, 1);
    assert.equal(spaces.filter(({ name, kind }) => name === '工作' && kind === 'public').length, 1);
    assert.equal(store.listSubscriptions().length, 1);
    const facts = store.listFacts();
    assert.equal(facts.length, 8);
    assert.equal(facts.every((fact) => store.getEpisode(fact.sourceEpisodeId)), true);
    store.close();
  }
});

test('starter-space check, bootstrap, and resolution share one immediate transaction', () => {
  const events = [];
  let transactionActive = false;
  const store = {
    transaction: (callback, options) => {
      events.push(['transaction', options]);
      transactionActive = true;
      try {
        return callback();
      } finally {
        transactionActive = false;
      }
    },
    listSpaces: () => {
      assert.equal(transactionActive, true);
      events.push(['listSpaces']);
      return [];
    }
  };
  const app = {
    bootstrap: () => {
      assert.equal(transactionActive, true);
      events.push(['bootstrap']);
    },
    requireActivePersonalSpace: () => {
      assert.equal(transactionActive, true);
      events.push(['requireActivePersonalSpace']);
      return { id: 'personal-1' };
    }
  };

  const active = initializeLocalSpaces(app, store, '我');

  assert.deepEqual(active, { id: 'personal-1' });
  assert.deepEqual(events, [
    ['transaction', { mode: 'immediate' }],
    ['listSpaces'],
    ['bootstrap'],
    ['requireActivePersonalSpace']
  ]);
});

test('failed starter bootstrap rolls back its partial SQLite writes', () => {
  const store = new SqliteStore(':memory:');
  const app = {
    bootstrap: () => {
      store.createSpace('我', SpaceKind.PERSONAL);
      throw new Error('bootstrap failed');
    },
    requireActivePersonalSpace: () => null
  };

  assert.throws(
    () => initializeLocalSpaces(app, store, '我'),
    /bootstrap failed/
  );
  assert.deepEqual(store.listSpaces(), []);
  store.close();
});

test('strict Zod schemas preserve every registry property and required field', () => {
  for (const definition of listAgentTools()) {
    const converted = jsonSchemaToZod(definition.inputSchema);
    const valid = sampleInput(definition.inputSchema);
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

test('schema conversion supports nullable, enum, numeric bounds, and integers', () => {
  const schema = jsonSchemaToZod({
    type: 'object',
    additionalProperties: false,
    required: ['nullable', 'mode', 'score', 'count', 'enabled'],
    properties: {
      nullable: { type: ['string', 'null'] },
      mode: { type: 'string', enum: ['one', 'two'] },
      score: { type: 'number', minimum: 0, maximum: 1 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      enabled: { type: 'boolean' }
    }
  });

  assert.equal(schema.safeParse({
    nullable: null, mode: 'two', score: 0.5, count: 2, enabled: true
  }).success, true);
  assert.equal(schema.safeParse({
    nullable: null, mode: 'three', score: 2, count: 1.5, enabled: true
  }).success, false);
});

test('annotations cover all tools and identify reads and destructive writes', () => {
  for (const { name } of listAgentTools()) {
    assert.deepEqual(Object.keys(annotationsFor(name)).sort(), [
      'destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'
    ]);
  }
  assert.deepEqual(annotationsFor('search_context'), {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false
  });
  assert.equal(annotationsFor('remember_user_fact').idempotentHint, false);
  assert.equal(annotationsFor('observe_git_diff').openWorldHint, true);
  assert.equal(annotationsFor('decide_candidate').destructiveHint, true);
  assert.equal(annotationsFor('correct_user_fact').destructiveHint, true);
});

test('tool errors expose controlled application messages and generic unexpected errors', () => {
  const controlled = errorToolResult(new ApplicationError(
    ApplicationErrorCode.VALIDATION,
    'Lens source contains sensitive content and cannot be stored'
  ));
  assert.equal(controlled.isError, true);
  assert.equal(controlled.structuredContent.error.code, 'validation');
  assert.match(controlled.content[0].text, /sensitive content/);

  const dynamic = errorToolResult(new ApplicationError(
    ApplicationErrorCode.NOT_FOUND,
    'Lens fact not found: private-user-supplied-id'
  ));
  assert.equal(dynamic.structuredContent.error.message, 'Lens fact not found');
  assert.equal(JSON.stringify(dynamic).includes('private-user-supplied-id'), false);

  const secret = 'sk-live-12345678901234567890';
  const unexpected = errorToolResult(new Error(`failed at T:\\private\\db.sqlite: ${secret}`));
  assert.deepEqual(unexpected.structuredContent, {
    error: { code: 'internal_error', message: 'Tool execution failed' }
  });
  assert.equal(JSON.stringify(unexpected).includes(secret), false);
  assert.equal(JSON.stringify(unexpected).includes('db.sqlite'), false);
});

test('close-once runtime closes MCP before the application exactly once', async () => {
  const calls = [];
  const close = createCloseOnce({
    closeServer: async () => calls.push('server'),
    closeApplication: () => calls.push('application')
  });

  await Promise.all([close(), close(), close()]);
  assert.deepEqual(calls, ['server', 'application']);
});

test('runtime still closes the application and settles event close failures', async () => {
  const calls = [];
  const close = createCloseOnce({
    closeServer: async () => {
      calls.push('server');
      throw new Error('private close failure');
    },
    closeApplication: () => calls.push('application')
  });
  let failed = false;
  const quietClose = createQuietCloser(close, () => { failed = true; });

  quietClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['server', 'application']);
  assert.equal(failed, true);
});

test('runtime closes an opened application when server creation fails', () => {
  let closes = 0;
  const app = { close: () => { closes += 1; } };

  assert.throws(
    () => createServerOrClose(app, () => { throw new Error('startup failure'); }),
    /startup failure/
  );
  assert.equal(closes, 1);
});

test('stdio startup failure keeps stdout clean and reports a safe stderr message', () => {
  const dbPath = tempDb('fuli-mcp-missing-space-');
  const app = createApplication({
    store: new SqliteStore(dbPath),
    activePersonalSpaceName: 'Existing'
  });
  app.createSpace('Existing', SpaceKind.PERSONAL);
  app.close();

  const child = spawnSync(NODE, [
    'src/mcp-server.js', '--db', dbPath, '--personal-space', 'Missing'
  ], { encoding: 'utf8', input: '' });

  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /Active personal space not found/);
  assert.equal(child.stderr.includes(dbPath), false);

  const store = new SqliteStore(dbPath);
  assert.deepEqual(store.listSpaces().map(({ name }) => name), ['Existing']);
  store.close();
});

function tempDb(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'context.db');
}

function sampleInput(schema) {
  return Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [
    name,
    sampleValue(property)
  ]));
}

function sampleValue(schema) {
  if (schema.enum) return schema.enum[0];
  if (Array.isArray(schema.type)) return schema.type.includes('string') ? 'value' : null;
  if (schema.type === 'string') return 'value';
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer') return Math.max(1, schema.minimum ?? 1);
  if (schema.type === 'number') return schema.minimum ?? 0;
  throw new Error(`No sample for ${schema.type}`);
}
