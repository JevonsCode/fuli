import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPiParticipant, createPiWorkspaceGuard, parsePiParticipantEvents, piRequestWithinContext } from '../src/agents/pi/roundtable-participant.js';
import { PARTICIPANT_RESULT_SCHEMA } from '../src/roundtables/result-contract.js';
import { createRoundtableTaskPrompt } from '../src/roundtables/turn-prompt.js';

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
    env: { PATH: process.env.PATH, FULI_ROUNDTABLE_TOKEN: 'peer-secret', OPENAI_API_KEY: 'cloud-secret', PI_CODING_AGENT_DIR: 'old-config',
      RIPGREP_CONFIG_PATH: 'unsafe-rg-config', rg_config_path: 'case-insensitive-unsafe', RG_OPTS: '--follow --pre unsafe', FD_OPTIONS: '--follow', FDFIND_OPTS: '--follow' },
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options, config: JSON.parse(readFileSync(join(options.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')) });
      const extension = args[args.indexOf('--extension') + 1];
      let loadedGuard;
      (await import(pathToFileURL(extension).href)).default({ on: (name, handler) => { if (name === 'tool_call') loadedGuard = handler; } });
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
  for (const key of ['RIPGREP_CONFIG_PATH', 'rg_config_path', 'RG_OPTS', 'FD_OPTIONS', 'FDFIND_OPTS']) assert.equal(first.options.env[key], undefined);
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
  for (const parameters of ['num_ctx 4096', 'num_ctx 8192', '']) {
    const insufficient = createPiParticipant({ ...options, fetchImpl: async (url) => url.endsWith('/api/show')
      ? { ok: true, json: async () => ({ parameters, capabilities: ['tools'], model_info: { 'qwen2.context_length': 32768 } }) }
      : fetchImpl(url) });
    assert.equal((await insufficient.preflight()).reason, 'model_context_insufficient');
  }
});

function createFormatterTestParticipant(options) {
  const adapter = createPiParticipant({ ...options,
    runProcess: (...args) => args[1].includes('--version') ? Promise.resolve({ code: 0, stdout: '1.1.0' }) : options.runProcess(...args),
    fetchImpl: async (url, request) => url.endsWith('/api/tags') ? { ok: true, json: async () => ({ models: [{ name: options.model }] }) }
      : url.endsWith('/api/show') ? { ok: true, json: async () => ({ parameters: 'num_ctx 16384', capabilities: ['tools'] }) }
        : options.fetchImpl(url, request)
  });
  const dispatch = adapter.dispatch.bind(adapter); let prepared = false;
  adapter.dispatch = async (input) => {
    if (!prepared) { assert.equal((await adapter.preflight()).ready, true); prepared = true; }
    return dispatch(input);
  };
  return adapter;
}

function executionPort(workspace, { write = true, read = true, verdict = 'passed', extraRead = false, report, toolError = false } = {}) {
  return async (_command, args) => {
    const extension = args[args.indexOf('--extension') + 1];
    (await import(pathToFileURL(extension).href)).default({ on() {} });
    const events = [{ type: 'session', id: 'pi-execution-session' }];
    if (write) {
      writeFileSync(join(workspace, 'evidence.txt'), 'ACTUAL_CONTENT');
      events.push({ type: 'tool_execution_start', toolCallId: 'actual-write', toolName: 'write', args: { path: 'evidence.txt', content: 'ACTUAL_CONTENT' } },
        { type: 'tool_execution_end', toolCallId: 'actual-write', toolName: 'write', isError: false, result: { content: [{ type: 'text', text: 'Wrote evidence.txt' }] } });
    }
    if (read) {
      if (!write) writeFileSync(join(workspace, 'evidence.txt'), 'READONLY_CONTENT');
      events.push({ type: 'tool_execution_start', toolCallId: 'actual-read', toolName: 'read', args: { path: 'evidence.txt' } },
        { type: 'tool_execution_end', toolCallId: 'actual-read', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: readFileSync(join(workspace, 'evidence.txt'), 'utf8') }] } });
    }
    if (extraRead) {
      writeFileSync(join(workspace, 'readonly.txt'), 'UNRELATED_READONLY');
      events.push({ type: 'tool_execution_start', toolCallId: 'unrelated-read', toolName: 'read', args: { path: 'readonly.txt' } },
        { type: 'tool_execution_end', toolCallId: 'unrelated-read', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'UNRELATED_READONLY' }] } });
    }
    if (toolError) events.push({ type: 'tool_execution_start', toolCallId: 'failed-write', toolName: 'write', args: { path: '../outside.txt', content: 'denied' } },
      { type: 'tool_execution_end', toolCallId: 'failed-write', toolName: 'write', isError: true, result: { content: [{ type: 'text', text: 'Fuli denied outside path' }] } });
    events.push({ type: 'message_end', message: message(report ?? `I completed the actual work.\nVerification verdict: ${verdict}`) }, { type: 'agent_settled', aborted: false });
    return { code: 0, stdout: events.map(JSON.stringify).join('\n') };
  };
}

const formattedEnvelope = (artifact) => ({ body: 'Actual file written.', status: 'completed', artifacts: artifact ? [{ id: artifact.id, uri: artifact.uri }] : [],
  verification: { passed: true, summary: 'Observed actual write and final file content.' }, dissent: [] });
const formattingResponse = (envelope) => new Response(JSON.stringify({ id: 'actual-local-format-response', model: 'provider-reported-model',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(envelope) } }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));

test('Pi formats completed real tool evidence once with no tools and separately accounts provider tokens', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-')); let calls = 0;
  try {
    const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured-model', runProcess: executionPort(workspace),
      fetchImpl: async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
        assert.equal(request.tools, undefined);
        assert.equal(request.response_format.json_schema.strict, true);
        assert.equal(input.evidence.files[0].content, 'ACTUAL_CONTENT');
        assert.equal(input.evidence.files[0].written, true);
        return formattingResponse(formattedEnvelope(input.evidence.files[0]));
      } });
    const result = await adapter.dispatch({ prompt: 'Write the literal ACTUAL_CONTENT.', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA });
    assert.equal(JSON.parse(result.body).status, 'completed');
    assert.equal(calls, 1);
    assert.equal(result.actual.sessionId, 'pi-execution-session');
    assert.equal(result.actual.model, 'real-model');
    assert.equal(result.actual.usage.totalTokens, 24);
    assert.equal(result.actual.usage.outputTokens, 7);
    assert.equal(result.actual.usage.inputTokens, null);
    assert.equal(result.actual.usage.stages[0].source, 'pi_executor');
    assert.equal(result.actual.usage.stages[1].source, 'local_ollama_formatter');
    assert.equal(result.actual.usage.stages[1].model, 'provider-reported-model');
    assert.equal(result.actual.usage.stages[1].cachedInputTokens, null);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi formatter cannot turn absent writes or invented artifact references into success', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  try {
    for (const write of [true, false]) {
      const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace, { write }),
        fetchImpl: async () => formattingResponse(formattedEnvelope({ id: 'invented', uri: 'file:///outside.txt' })) });
      await assert.rejects(adapter.dispatch({ prompt: 'Create evidence.txt', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_result_invalid' });
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi completed writes require references to written files, and formatter cannot invent a passed verification', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  try {
    for (const scenario of [
      { options: { extraRead: true }, select: (files) => files.find((file) => file.path === 'readonly.txt') },
      { options: { verdict: 'not_checked' }, select: (files) => files[0], prohibitedPass: true },
      { options: { read: false }, select: (files) => files[0], prohibitedPass: true }
    ]) {
      const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace, scenario.options),
        fetchImpl: async (_url, options) => {
          const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
          if (scenario.prohibitedPass) assert.deepEqual(request.response_format.json_schema.schema.properties.verification.properties.passed.enum, [false, null]);
          return formattingResponse(formattedEnvelope(scenario.select(input.evidence.files)));
        } });
      await assert.rejects(adapter.dispatch({ prompt: 'Create and verify evidence.txt', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_result_invalid' });
    }
    const reviewer = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace, { write: false, verdict: 'not_checked' }),
      fetchImpl: async (_url, options) => formattingResponse(formattedEnvelope(JSON.parse(JSON.parse(options.body).messages[1].content).evidence.files[0])) });
    await assert.rejects(reviewer.dispatch({ prompt: 'Review existing file', resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_result_invalid' });
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi execution receives complete structured turn context before separately formatting the original contract', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  const context = { phase: 'implementation', currentTask: { body: 'Create evidence.txt' }, goal: 'Public goal',
    messages: [{ kind: 'human', sourceApplication: 'local-owner', body: 'Owner clarification' }, { kind: 'result', body: 'Peer evidence' }], custom: { preserved: true } };
  const originalPrompt = 'ORIGINAL RESULT CONTRACT WITH JSON SCHEMA'; let executionInput, formatterTask;
  try {
    const execute = executionPort(workspace);
    const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured',
      runProcess: async (...args) => { executionInput = args[2].input; return execute(...args); },
      fetchImpl: async (_url, options) => {
        const input = JSON.parse(JSON.parse(options.body).messages[1].content); formatterTask = input.task;
        return formattingResponse(formattedEnvelope(input.evidence.files[0]));
      } });
    await adapter.dispatch({ prompt: originalPrompt, turn: { context }, allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA });
    assert.equal(executionInput, createRoundtableTaskPrompt(context, { allowWrite: true }));
    assert.ok(executionInput.includes(JSON.stringify(context)));
    assert.equal(executionInput.includes(originalPrompt), false);
    assert.equal(formatterTask, originalPrompt);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi readonly discussion uses the shared phase task without adding write tools or the result contract', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  const context = { phase: 'discussion', goal: 'Implement a later artifact', currentTask: null,
    tasks: [{ id: 'later-implementation', status: 'pending' }], currentTasks: [],
    messages: [{ kind: 'human', sourceApplication: 'local-owner', body: 'Discuss the plan first' }] };
  const originalPrompt = 'FULL ORIGINAL WORKER RESULT CONTRACT'; let executionInput, tools;
  try {
    const execute = executionPort(workspace, { write: false });
    const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured',
      runProcess: async (...args) => { executionInput = args[2].input; tools = args[1][args[1].indexOf('--tools') + 1]; return execute(...args); },
      fetchImpl: async (_url, options) => {
        const input = JSON.parse(JSON.parse(options.body).messages[1].content);
        assert.equal(input.task, originalPrompt);
        return formattingResponse(formattedEnvelope(input.evidence.files[0]));
      } });
    const result = await adapter.dispatch({ prompt: originalPrompt, turn: { context }, resultSchema: PARTICIPANT_RESULT_SCHEMA });
    assert.equal(executionInput, createRoundtableTaskPrompt(context, { allowWrite: false }));
    assert.ok(executionInput.includes(JSON.stringify(context)));
    assert.equal(executionInput.includes(originalPrompt), false);
    assert.equal(tools, 'read,grep,find,ls');
    assert.equal(JSON.parse(result.body).status, 'completed');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi formatter must preserve every parseable original dissent and may add new dissent', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  const original = ['Original disagreement must survive'];
  try {
    for (const preserve of [false, true]) {
      const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured',
        runProcess: executionPort(workspace, { report: JSON.stringify({ body: 'Malformed envelope needs formatting', dissent: original }) }),
        fetchImpl: async (_url, options) => {
          const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
          assert.deepEqual(input.reportedDissent, original);
          assert.equal(request.response_format.json_schema.schema.properties.dissent.minItems, 1);
          return formattingResponse({ ...formattedEnvelope(input.evidence.files[0]), verification: { passed: false, summary: 'No declared verdict' },
            dissent: preserve ? [...original, 'Another disagreement'] : [] });
        } });
      const pending = adapter.dispatch({ prompt: 'Create evidence.txt', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA });
      if (!preserve) await assert.rejects(pending, { code: 'formatter_result_invalid' });
      else assert.deepEqual(JSON.parse((await pending).body).dissent, [...original, 'Another disagreement']);
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi formatter cannot upgrade an explicit failed or blocked execution into completed', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  try {
    for (const status of ['failed', 'blocked']) {
      const rawEnvelope = { ...formattedEnvelope({ id: 'unresolved', uri: 'file:///not-observed' }), status };
      const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace, { report: JSON.stringify(rawEnvelope) }),
        fetchImpl: async (_url, options) => {
          const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
          assert.deepEqual(request.response_format.json_schema.schema.properties.status.enum, [status]);
          assert.deepEqual(request.response_format.json_schema.schema.properties.verification.properties.passed.enum, [false, null]);
          return formattingResponse({ ...formattedEnvelope(input.evidence.files[0]), verification: { passed: false, summary: 'No verification' } });
        } });
      await assert.rejects(adapter.dispatch({ prompt: 'Create evidence.txt', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_result_invalid' });
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi partial artifact plus failed verdict or tool error cannot be formatted as completed', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  try {
    for (const options of [{ verdict: 'failed' }, { toolError: true, verdict: 'not_checked' }]) {
      const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace, options),
        fetchImpl: async (_url, options) => {
          const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
          assert.deepEqual(request.response_format.json_schema.schema.properties.status.enum, ['failed']);
          return formattingResponse({ ...formattedEnvelope(input.evidence.files[0]), verification: { passed: false, summary: 'Partial file present; check failed' } });
        } });
      await assert.rejects(adapter.dispatch({ prompt: 'Create all requested files', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_result_invalid' });
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi partial parseable execution status and false verdict survive result-envelope repairs', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-'));
  try {
    for (const report of [{ body: 'partial', status: 'failed' }, { body: 'partial', status: 'blocked' },
      { body: 'partial', verification: { passed: false } }]) {
      const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured',
        runProcess: executionPort(workspace, { report: JSON.stringify(report) }),
        fetchImpl: async (_url, options) => {
          const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
          assert.deepEqual(request.response_format.json_schema.schema.properties.verification.properties.passed.enum, [false, null]);
          if (report.status) assert.deepEqual(request.response_format.json_schema.schema.properties.status.enum, [report.status]);
          return formattingResponse({ ...formattedEnvelope(input.evidence.files[0]), verification: { passed: report.status ? false : true, summary: 'Invented repaired result' } });
        } });
      await assert.rejects(adapter.dispatch({ prompt: 'Create evidence.txt', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_result_invalid' });
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi refuses complete formatter input that would exceed the real model context without truncation', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-')); let fetched = false;
  try {
    const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace),
      fetchImpl: async () => { fetched = true; throw new Error('not expected'); } });
    await assert.rejects(adapter.dispatch({ prompt: 'x'.repeat(13_000), allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_context_budget_exceeded' });
    assert.equal(fetched, false);
    assert.equal(piRequestWithinContext({ messages: [{ content: '你好'.repeat(3000) }], max_tokens: 4096 }, 16384), false);
    assert.equal(piRequestWithinContext({ messages: [{ content: 'safe' }], max_tokens: 4096 }, 16384), true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi emitted context guard aborts before an oversized provider request and reports explicit failure', async () => {
  let aborted = false;
  const adapter = createPiParticipant({ model: 'configured', command: 'mock-pi', runProcess: async (_command, args) => {
    const extension = args[args.indexOf('--extension') + 1]; let budgetGuard;
    (await import(pathToFileURL(extension).href)).default({ on: (name, handler) => { if (name === 'before_provider_request') budgetGuard = handler; } });
    budgetGuard({ payload: { messages: [{ content: 'oversized'.repeat(3000) }], max_tokens: 4096 } }, { abort: () => { aborted = true; } });
    return { code: 0, stdout: stream().replace('"aborted":false', '"aborted":true') };
  } });
  await assert.rejects(adapter.dispatch({ prompt: 'large context' }), { code: 'context_budget_exceeded' });
  assert.equal(aborted, true);
});

test('Pi formatter refuses truncated evidence instead of summarizing or guessing', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-')); let fetched = false;
  try {
    const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace),
      fetchImpl: async () => { fetched = true; throw new Error('not expected'); } });
    await assert.rejects(adapter.dispatch({ prompt: 'x'.repeat(70_000), allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_evidence_too_large' });
    assert.equal(fetched, false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi executor and formatter share cancellation and remain busy until formatting is finished', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-')); const controller = new AbortController();
  let started; const formattingStarted = new Promise((resolve) => { started = resolve; });
  try {
    const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace),
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }) });
    const pending = adapter.dispatch({ prompt: 'Write a file', allowWrite: true, signal: controller.signal, resultSchema: PARTICIPANT_RESULT_SCHEMA });
    await formattingStarted;
    await assert.rejects(adapter.dispatch({ prompt: 'Another turn' }), { code: 'participant_busy' });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'cancelled' && error.actual.usage.totalTokens === null && error.actual.usage.stages[0].totalTokens === 15);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Pi formatter cancels an unsuccessful HTTP response body before returning failure', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fuli-pi-format-')); let cancelled = false;
  try {
    const adapter = createFormatterTestParticipant({ workspace, command: 'mock-pi', model: 'configured', runProcess: executionPort(workspace),
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 }) });
    await assert.rejects(adapter.dispatch({ prompt: 'Write and check evidence.txt', allowWrite: true, resultSchema: PARTICIPANT_RESULT_SCHEMA }), { code: 'formatter_failed' });
    assert.equal(cancelled, true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
