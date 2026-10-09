import test from 'node:test';
import assert from 'node:assert/strict';
import { runParticipantProcess, parseParticipantEvents } from '../src/roundtables/process.js';
import { createCodexParticipant } from '../src/agents/codex/roundtable-participant.js';
import { createClaudeCodeParticipant } from '../src/agents/claude-code/roundtable-participant.js';
import { validateCoordinatorUrl } from '../src/roundtables/worker.js';
import { runRoundtableWorker } from '../src/roundtables/worker.js';
import { createRoundtableService } from '../src/roundtables/service.js';
import { createRoundtableServer } from '../src/roundtables/server.js';
import { setTimeout as delay } from 'node:timers/promises';

test('owned real subprocess is bounded and cancelled without returning partial results', async () => {
  const controller = new AbortController();
  const pending = runParticipantProcess(process.execPath, ['-e', 'process.stdout.write("partial");setInterval(()=>{},100)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'cancelled' });
  await assert.rejects(runParticipantProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], { maxOutputBytes: 50 }), { code: 'output_too_large' });
});

test('CLI protocol fixtures use runtime-reported session/usage, failure never becomes success', async () => {
  const events = [{ type: 'thread.started', thread_id: 'actual-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'actual answer' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }].map(JSON.stringify).join('\n');
  assert.deepEqual(parseParticipantEvents('codex', { code: 0, stdout: events }).actual,
    { sourceApplication: 'codex', sessionId: 'actual-session', model: null, usage: { source: 'executor', input_tokens: 12, output_tokens: 4 }, evidenceLevel: 'real_cli' });
  assert.throws(() => parseParticipantEvents('codex', { code: 0, stdout: `${events}\n{"type":"turn.failed"}` }), { code: 'runtime_failed' });
  assert.throws(() => parseParticipantEvents('codex', { code: 1, stdout: events }), error =>
    error.actual.sessionId === 'actual-session' && error.actual.usage.output_tokens === 4);
  const completedAfterReconnect = events.replace('{"type":"turn.completed"', '{"type":"error","message":"Reconnecting... 2/5 (tls handshake eof)"}\n{"type":"turn.completed"');
  assert.equal(parseParticipantEvents('codex', { code: 0, stdout: completedAfterReconnect }).body, 'actual answer');
  assert.throws(() => parseParticipantEvents('codex', { code: 0, stdout: `${events}\n{"type":"error","message":"fatal after completion"}` }), { code: 'runtime_failed' });
  assert.throws(() => parseParticipantEvents('codex', { code: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"unconfirmed"}}' }), { code: 'runtime_failed' });
  assert.throws(() => parseParticipantEvents('claude_code', { code: 0, stdout: '{"type":"result","is_error":true,"result":"401"}' }), { code: 'runtime_failed' });
});

test('Codex boundary defaults readonly, removes participant secrets and verifies effective MCP disabled', async () => {
  const calls = [];
  const adapter = createCodexParticipant({ env: { PATH: process.env.PATH, FULI_ROUNDTABLE_TOKEN: 'secret' },
    runProcess: async (...args) => { calls.push(args); return { code: 0, stdout: args[1][0] === 'mcp' ? '[]' : '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed"}' }; } });
  await adapter.dispatch({ prompt: 'read-only goal' });
  const [, args, options] = calls.find(([, values]) => values[0] === 'exec');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('plugins')); assert.ok(args.includes('apps'));
  assert.equal(calls.filter(([, values]) => values[0] === 'mcp').length, 2);
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=[]'));
  assert.equal(options.env.FULI_ROUNDTABLE_TOKEN, undefined);
});

test('Claude boundary no inherited hooks/MCP/tools; readonly excludes file mutation', async () => {
  let args;
  const adapter = createClaudeCodeParticipant({ runProcess: async (_command, values) => { args = values; return { code: 0, stdout: '{"type":"result","result":"answer"}' }; } });
  await adapter.dispatch({ prompt: 'readonly' });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('{"disableAllHooks":true}'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('remote worker URL forbids credentials/redirect invitations and insecure implicit remote HTTP', () => {
  assert.equal(validateCoordinatorUrl('http://127.0.0.1:3738'), 'http://127.0.0.1:3738');
  assert.equal(validateCoordinatorUrl('https://roundtable.example'), 'https://roundtable.example');
  assert.throws(() => validateCoordinatorUrl('http://public.example'));
  assert.throws(() => validateCoordinatorUrl('https://user:secret@example.com'));
  assert.throws(() => validateCoordinatorUrl('https://example.com?token=secret'));
});

test('network worker preserves owner pause but cancels its child when the claimed fence is invalidated', async (t) => {
  let now = Date.now(), dispatchSignal;
  const service = createRoundtableService({ clock: () => now });
  const host = await createRoundtableServer({ service, port: 0 });
  const owner = { kind: 'owner' };
  const roomId = service.create({ goal: 'Verify owned worker cancellation', seats: [
    { id: 'a', name: 'A', role: 'moderator' }, { id: 'b', name: 'B', role: 'specialist' }
  ], limits: { turnTimeoutMs: 120000 } }, owner).room.id;
  const { seatToken } = service.invite({ roomId, seatId: 'a' }, owner);
  const actor = service.authenticate({ roomId, seatToken, sourceApplication: 'other', sourceSessionId: 'worker' });
  service.join({ roomId }, actor);
  const otherToken = service.invite({ roomId, seatId: 'b' }, owner).seatToken;
  service.join({ roomId }, service.authenticate({ roomId, seatToken: otherToken, sourceApplication: 'other', sourceSessionId: 'peer' }));
  service.control({ roomId, action: 'start' }, owner);
  const stop = new AbortController();
  t.after(async () => { stop.abort(); await host.close(); service.close(); });
  const outcome = runRoundtableWorker({ url: host.url, roomId, runtime: 'codex', once: true,
    env: { FULI_ROUNDTABLE_TOKEN: seatToken }, signal: stop.signal,
    participant: { preflight: async () => ({ ready: true }), dispatch: async ({ signal }) => {
      dispatchSignal = signal;
      await delay(10000, undefined, { signal });
      throw new Error('Cancellation did not arrive');
    } }
  }).then(result => ({ result }), error => ({ error }));
  for (let attempt = 0; !dispatchSignal && attempt < 100; attempt++) await delay(10);
  assert.ok(dispatchSignal, 'real network worker must claim and dispatch');
  service.control({ roomId, action: 'pause' }, owner);
  await delay(1150);
  assert.equal(dispatchSignal.aborted, false, 'owner pause preserves the same current attempt');
  now += 120001;
  const expired = service.read({ roomId }, owner);
  assert.equal(expired.currentTurn.status, 'interrupted');
  const ended = await Promise.race([outcome, delay(4000).then(() => ({ timeout: true }))]);
  assert.equal(ended.timeout, undefined);
  assert.equal(dispatchSignal.aborted, true, 'invalidated lease must stop the owned child before retry');
  assert.equal(ended.error?.status, 409, 'stale result cannot advance the room');
  assert.equal(service.read({ roomId }, owner).messages.length, 0);
});
