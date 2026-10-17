import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess, wakeAgent } from '../src/agent-roundtable/wake.js';

const program = `
const first = JSON.stringify({type:'thread.started',thread_id:'native-receiver-123'})+'\\n';
const answer = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'目标知识：中文完整'}})+'\\n';
const bytes=Buffer.from(first+answer+JSON.stringify({type:'turn.completed'})+'\\n');
const cut=bytes.indexOf(Buffer.from('目标'))+1;
process.stdout.write(bytes.subarray(0,cut));
setTimeout(()=>process.stdout.write(bytes.subarray(cut)),30);
`;

test('native session events and multibyte replies survive split stdout chunks', async () => {
  const events = [];
  const result = await runProcess(process.execPath, ['-e', program], {
    cwd: process.cwd(), env: process.env, input: '', timeoutMs: 10_000,
    onEvent: event => { events.push(event); }
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /目标知识：中文完整/);
  assert.equal(events[0].thread_id, 'native-receiver-123');
  assert.equal(events.length, 3);
});

test('wake seals an observed native session before accepting its final answer', async () => {
  const seals = [];
  const result = await wakeAgent({ client: 'codex', cwd: process.cwd(), prompt: 'Synthetic bounded question',
    env: { ...process.env, FULI_CODEX_BIN: process.execPath },
    onSession: async session => { seals.push(session); },
    run: (_, __, options) => runProcess(process.execPath, ['-e', program], options)
  });
  assert.deepEqual(seals, ['native-receiver-123']);
  assert.equal(result.sessionId, 'native-receiver-123');
  assert.equal(result.body, '目标知识：中文完整');
});

test('a failed native session seal rejects the answer', async () => {
  await assert.rejects(wakeAgent({ client: 'codex', cwd: process.cwd(), prompt: 'Synthetic question',
    env: { ...process.env, FULI_CODEX_BIN: process.execPath },
    onSession: async () => { throw Object.assign(new Error('Grant revoked'), { code: 'grant_revoked' }); },
    run: (_, __, options) => runProcess(process.execPath, ['-e', program], options)
  }), { code: 'grant_revoked' });
});

test('answer metadata alone cannot establish the native session', async () => {
  const resultOnly = JSON.stringify({ type: 'result', session_id: 'forged-session', result: 'Synthetic answer' });
  await assert.rejects(wakeAgent({ client: 'claude_code', cwd: process.cwd(), prompt: 'Synthetic question',
    env: { ...process.env, FULI_CLAUDE_BIN: process.execPath }, onSession: async () => {},
    run: (_, __, options) => runProcess(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(resultOnly)})`], options)
  }), { code: 'session_mismatch' });
});
