import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPiParticipant, createPiWorkspaceGuard, parsePiParticipantEvents } from '../src/agents/pi/roundtable-participant.js';

const message = (text, usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }) =>
  ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', provider: 'ollama', model: 'real-model', usage });
const stream = (messages = [message('answer')]) => [{ type: 'session', id: 'actual-pi-session' },
  ...messages.map((value) => ({ type: 'message_end', message: value })), { type: 'agent_settled', aborted: false }].map(JSON.stringify).join('\n');

test('Pi takes final authoritative text and cumulative executor usage, never configured model/session', () => {
  const result = parsePiParticipantEvents({ code: 0, stdout: stream([message('earlier'), message('final')]) });
  assert.equal(result.body, 'final');
  assert.deepEqual(result.actual, { sourceApplication: 'other', applicationLabel: 'Pi', provider: 'ollama', model: 'real-model',
    sessionId: 'actual-pi-session', evidenceLevel: 'real_cli', usage: { source: 'executor', inputTokens: 20, outputTokens: 10,
      cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: null, totalTokens: 30 } });
  assert.equal(parsePiParticipantEvents({ code: 0, stdout: stream([message('answer', null)]) }).actual.usage, null);
});

test('Pi error, unfinished run, missing text or oversized final cannot become success', () => {
  for (const stdout of [stream().replace('"aborted":false', '"aborted":true'), stream().replace('"stopReason":"stop"', '"stopReason":"error"'),
    `${stream()}\n{"type":"extension_error"}`, stream().replace('{"type":"agent_settled","aborted":false}', '')]) {
    assert.throws(() => parsePiParticipantEvents({ code: 0, stdout }), { code: 'runtime_failed' });
  }
  assert.throws(() => parsePiParticipantEvents({ code: 0, stdout: stream([message('x'.repeat(16_385))]) }), { code: 'response_invalid' });
  assert.throws(() => parsePiParticipantEvents({ code: 0, stdout: 'not-json' }), { code: 'response_invalid' });
});

test('Pi file guard denies shell, mutation without grant, outside paths and symlink ancestors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-pi-test-'));
  try {
    const workspace = join(directory, 'workspace'), outside = join(directory, 'outside');
    mkdirSync(workspace); mkdirSync(outside);
    writeFileSync(join(workspace, 'existing.txt'), 'inside');
    const guard = createPiWorkspaceGuard(workspace), writer = createPiWorkspaceGuard(workspace, true);
    assert.equal(guard({ toolName: 'read', input: { path: 'existing.txt' } }), undefined);
    assert.equal(guard({ toolName: 'ls', input: {} }), undefined);
    const canonical = { toolName: 'read', input: { path: 'existing.txt' } };
    assert.equal(guard(canonical), undefined);
    assert.equal(canonical.input.path, join(workspace, 'existing.txt'));
    assert.equal(writer({ toolName: 'write', input: { path: 'nested/new.txt' } }), undefined);
    for (const call of [{ toolName: 'bash', input: { command: 'echo unsafe' } }, { toolName: 'write', input: { path: 'new.txt' } },
      { toolName: 'read', input: { path: '../outside/file.txt' } }, { toolName: 'read', input: { path: outside } },
      { toolName: 'read', input: { path: '~/.pi/agent/auth.json' } }, { toolName: 'write', input: { path: 'C:relative' } }]) {
      assert.equal(guard(call)?.block, true);
    }
    for (const path of ['@../outside.txt', '@~/outside.txt', 'file:///outside.txt', '/c/outside.txt', '/mnt/c/outside.txt',
      '/cygdrive/c/outside.txt', 'unicode\u00a0space.txt']) {
      assert.equal(writer({ toolName: 'write', input: { path } })?.block, true, path);
    }
    symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(writer({ toolName: 'write', input: { path: 'escape/new.txt' } })?.block, true);
    assert.equal(guard({ toolName: 'read', input: { path: 'escape/file.txt' } })?.block, true);
    symlinkSync(join(outside, 'missing'), join(workspace, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(writer({ toolName: 'write', input: { path: 'dangling/new.txt' } })?.block, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Pi uses isolated settings, no inherited MCP/resources, stdin prompt and granted file tools', async () => {
  const calls = [];
  const adapter = createPiParticipant({ model: 'configured-model', command: 'mock-pi',
    env: { PATH: process.env.PATH, FULI_ROUNDTABLE_TOKEN: 'peer-secret', OPENAI_API_KEY: 'cloud-secret', PI_CODING_AGENT_DIR: 'old-config' },
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options, config: JSON.parse(readFileSync(join(options.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')) });
      const extension = args[args.indexOf('--extension') + 1];
      let loadedGuard;
      (await import(pathToFileURL(extension).href)).default({ on: (name, handler) => { assert.equal(name, 'tool_call'); loadedGuard = handler; } });
      assert.equal(loadedGuard({ toolName: 'read', input: { path: 'package.json' } }), undefined);
      assert.equal(loadedGuard({ toolName: 'write', input: { path: '@../outside.txt' } })?.block, true);
      return { code: 0, stdout: stream() };
    } });
  await adapter.dispatch({ prompt: 'secret-safe stdin' });
  await adapter.dispatch({ prompt: 'write grant', allowWrite: true });
  const first = calls[0];
  for (const flag of ['--no-approve', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-session', '--offline']) assert.ok(first.args.includes(flag));
  assert.equal(first.args[first.args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.equal(calls[1].args[calls[1].args.indexOf('--tools') + 1], 'read,grep,find,ls,edit,write');
  assert.equal(first.options.input, 'secret-safe stdin');
  assert.equal(first.options.env.FULI_ROUNDTABLE_TOKEN, undefined);
  assert.equal(first.options.env.OPENAI_API_KEY, undefined);
  assert.notEqual(first.options.env.PI_CODING_AGENT_DIR, 'old-config');
  assert.equal(first.config.providers.ollama.models[0].id, 'configured-model');
  assert.equal(existsSync(first.options.env.PI_CODING_AGENT_DIR), false);
});

test('Pi missing permission extension fails closed and cleans owned configuration', async () => {
  let directory;
  const adapter = createPiParticipant({ model: 'test', command: 'mock-pi', runProcess: async (_command, _args, options) => {
    directory = options.env.PI_CODING_AGENT_DIR; return { code: 0, stdout: stream() };
  } });
  await assert.rejects(adapter.dispatch({ prompt: 'test' }), { code: 'permission_guard_unavailable' });
  assert.equal(existsSync(directory), false);
});

test('Pi preflight requires selected installed local model and an isolation-capable runtime', async () => {
  const fetchImpl = async (url) => ({ ok: true, json: async () => url.endsWith('/api/show')
    ? { parameters: 'num_ctx 16384', capabilities: ['tools'], model_info: { 'qwen2.context_length': 32768 } }
    : { models: [{ name: 'qwen2.5:14b' }] } });
  const runProcess = async () => ({ code: 0, stdout: '1.1.0\n' });
  const options = { command: 'mock-pi', model: 'qwen2.5:14b', runProcess, fetchImpl };
  assert.equal((await createPiParticipant(options).preflight()).ready, true);
  assert.equal((await createPiParticipant(options).preflight()).contextWindow, 16384);
  assert.equal((await createPiParticipant({ ...options, model: 'missing' }).preflight()).reason, 'model_unavailable');
  assert.equal((await createPiParticipant({ ...options, model: '' }).preflight()).reason, 'missing_model');
  assert.equal((await createPiParticipant({ ...options, baseUrl: 'http://example.com/v1' }).preflight()).reason, 'invalid_endpoint');
  assert.equal((await createPiParticipant({ ...options, runProcess: async () => ({ code: 0, stdout: '0.73.1' }) }).preflight()).reason, 'runtime_version_unsupported');
});
