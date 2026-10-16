import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises, { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCodexAcpProcess } from '../src/agents/codex/acp-process.js';
import { inspectWindowsNativeProcess, stopWindowsNativeProcess } from '../src/native-runtime/windows-processes.js';

const secret = 'SYNTHETIC_PRIVATE_VALUE_NEVER_LOG';
const windowsOnly = { skip: process.platform !== 'win32' };
async function fixture(t, mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'fuli ACP process '));
  const codexHome = join(root, 'isolated home'), cwd = join(root, 'clean cwd');
  await mkdir(codexHome); await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = join(root, 'observed.json');
  const adapterPath = join(root, 'synthetic adapter.cjs');
  await writeFile(adapterPath, `
const fs = require('node:fs'), readline = require('node:readline'), {spawn}=require('node:child_process');
const mode=${JSON.stringify(mode)}, record=${JSON.stringify(record)}, secret=${JSON.stringify(secret)};
const forbidden=['CODEX_THREAD_ID','OPENAI_API_KEY','ANTHROPIC_API_KEY','DEFAULT_AUTH_REQUEST',
  'CODEX_CONFIG','APP_SERVER_LOGS','NODE_OPTIONS','NODE_PATH','MODEL_PROVIDER'];
const observed={pid:process.pid, home:process.env.CODEX_HOME, cwd:process.cwd(),
  inheritedKeys:forbidden.filter(key=>process.env[key]!==undefined), methods:[]};
const save=()=>fs.writeFileSync(record,JSON.stringify(observed)); save();
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
process.stderr.write(secret.repeat(6000));
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
  const value=JSON.parse(line);
  if(value.method){observed.methods.push(value.method);save();}
  if(value.method==='initialize'){
    if(mode==='hang'){
      const child=spawn(process.env.CODEX_PATH,['-e','setInterval(()=>{},1000)','app-server'],{stdio:'ignore'});
      observed.childPid=child.pid; save(); setInterval(()=>{},1000); return;
    }
    if(mode==='eof'){process.exit(0);}
    if(mode==='invalid'){send({secret});return;}
    if(mode==='unknown-response'){send({jsonrpc:'2.0',id:secret,result:{}});return;}
    if(mode==='bad-schema'){send({jsonrpc:'2.0',id:value.id,result:{protocolVersion:secret}});return;}
    if(mode==='permission'){
      observed.initializeId=value.id;save();
      send({jsonrpc:'2.0',id:77,method:'session/request_permission',params:{sessionId:'synthetic-session',
        toolCall:{toolCallId:'synthetic-call',title:secret},options:[{optionId:'yes',name:secret,kind:'allow_once'}]}});
      return;
    }
    reply(value.id);
  }else if(value.id===77){observed.permission=value.result;save();reply(observed.initializeId);}
});
function reply(id){
  send({jsonrpc:'2.0',id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'synthetic',version:'1'}}});
  send({jsonrpc:'2.0',method:'_auth/status_update',params:{authStatus:{kind:'none',account:{email:secret}}}});
}
input.on('close',()=>{if(mode!=='hang')process.exit(0);});
`);
  return { root, record, options: { adapterPath, codexPath: process.execPath, codexHome, cwd,
    initializeTimeoutMs: 3000, stopTimeoutMs: 8000,
    env: { ...process.env, CODEX_THREAD_ID: secret, OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret,
      DEFAULT_AUTH_REQUEST: secret, CODEX_CONFIG: secret, APP_SERVER_LOGS: secret,
      NODE_OPTIONS: '--this-must-be-removed', NODE_PATH: secret, MODEL_PROVIDER: secret } } };
}
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

test('ACP initializes only, isolates environment, drains stderr and closes idempotently', windowsOnly, async t => {
  const { options, record } = await fixture(t);
  const handle = await startCodexAcpProcess(options);
  assert.equal(handle.initialization.protocolVersion, 1);
  assert.ok(['unknown', 'none'].includes(handle.authentication));
  assert.equal(JSON.stringify(handle.diagnostics).includes(secret), false);
  assert.ok(handle.diagnostics.stderrBytes <= 64 * 1024);
  assert.equal(handle.diagnostics.stderrTruncated, true);
  await Promise.all([handle.close(), handle.close(), handle.closed]);
  assert.equal(handle.signal.aborted, true);
  assert.equal(gone(handle.pid), true);
  const observed = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(observed.methods, ['initialize']);
  assert.deepEqual(observed.inheritedKeys, []);
  assert.equal(observed.home, options.codexHome);
  assert.equal(observed.cwd, options.cwd);
});

test('ACP permission requests are cancelled and retain only bounded host metadata', windowsOnly, async t => {
  const { options, record } = await fixture(t, 'permission');
  const handle = await startCodexAcpProcess(options);
  try {
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')).permission, { outcome: { outcome: 'cancelled' } });
    assert.equal(handle.pendingPermissions[0].toolCallId, 'synthetic-call');
    assert.equal(JSON.stringify(handle.pendingPermissions).includes(secret), false);
  } finally { await handle.close(); }
});

test('ACP timeout and caller cancellation reject pending initialize and stop only their processes', windowsOnly, async t => {
  for (const cancel of [false, true]) {
    const { options, record } = await fixture(t, 'hang');
    const controller = new AbortController();
    const timer = cancel ? setTimeout(() => controller.abort(new Error(secret)), 1500) : null;
    const start = performance.now();
    try {
      await assert.rejects(startCodexAcpProcess({ ...options, initializeTimeoutMs: cancel ? 5000 : 1500,
        signal: controller.signal }), error => {
        assert.equal(error.code, cancel ? 'acp_cancelled' : 'acp_timeout');
        assert.equal((error.stack + JSON.stringify(error)).includes(secret), false);
        return true;
      });
      const observed = JSON.parse(await readFile(record, 'utf8'));
      assert.equal(gone(observed.pid), true);
      if (observed.childPid) assert.equal(gone(observed.childPid), true);
      assert.ok(performance.now() - start < 15_000);
    } finally { clearTimeout(timer); }
  }
});

test('ACP one-millisecond initialization timeout cleans the spawned adapter before rejecting', windowsOnly, async t => {
  const { options, record } = await fixture(t);
  let observed;
  try {
    await assert.rejects(startCodexAcpProcess({ ...options, initializeTimeoutMs: 1 }), { code: 'acp_timeout' });
    for (let attempt = 0; attempt < 20 && !observed; attempt++) {
      observed = await readFile(record, 'utf8').then(JSON.parse).catch(() => null);
      if (!observed) await delay(25);
    }
    assert.ok(observed, 'the spawned adapter must record its PID');
    assert.equal(gone(observed.pid), true, 'timeout rejection must wait for process cleanup');
  } finally {
    const owner = observed && await inspectWindowsNativeProcess(observed.pid);
    if (owner) {
      assert.ok(owner.commandLine.includes(options.adapterPath));
      await stopWindowsNativeProcess(owner.pid, { pid: owner.pid, command: owner.executable, ownership: owner }, { timeoutMs: 8000 });
    }
  }
});

test('ACP cancellation during executable realpath is preserved before any spawn', windowsOnly, async t => {
  const { options, record } = await fixture(t, 'hang');
  const controller = new AbortController(), originalRealpath = fsPromises.realpath;
  let nodeRealpathCalls = 0;
  const spy = t.mock.method(fsPromises, 'realpath', async (path, ...args) => {
    const value = await originalRealpath(path, ...args);
    if (path === process.execPath && ++nodeRealpathCalls === 2) controller.abort(new Error(secret));
    return value;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(startCodexAcpProcess({ ...options, initializeTimeoutMs: 5000,
      signal: controller.signal }), { code: 'acp_cancelled' });
    assert.equal(nodeRealpathCalls, 2);
    await assert.rejects(readFile(record), { code: 'ENOENT' });
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test('ACP EOF, malformed envelopes, unknown response IDs and bad schemas fail without raw logging', windowsOnly, async t => {
  const errors = [];
  const spy = t.mock.method(console, 'error', (...args) => errors.push(args));
  for (const mode of ['eof', 'invalid', 'unknown-response', 'bad-schema']) {
    const { options, record } = await fixture(t, mode);
    await assert.rejects(startCodexAcpProcess(options), error => {
      assert.ok(['acp_closed', 'acp_protocol_error', 'acp_handshake_failed', 'acp_cleanup_incomplete'].includes(error.code));
      assert.equal((error.stack + JSON.stringify(error)).includes(secret), false);
      return true;
    });
    assert.equal(gone(JSON.parse(await readFile(record, 'utf8')).pid), true);
  }
  assert.deepEqual(errors, []);
  spy.mock.restore();
});

test('Windows ownership inspection enforces its explicit timeout', windowsOnly, async () => {
  const started = performance.now();
  await assert.rejects(inspectWindowsNativeProcess(process.pid, { timeoutMs: 1 }));
  assert.ok(performance.now() - started < 3000);
});

test('official Codex ACP 2.2.2 initializes and exits in an empty isolated home without a session', {
  skip: process.platform !== 'win32' || process.env.FULI_TEST_CODEX_ACP_INITIALIZE !== '1', timeout: 60_000
}, async t => {
  assert.ok(process.env.FULI_TEST_CODEX_ACP_ADAPTER && process.env.FULI_TEST_CODEX_BINARY);
  const { options } = await fixture(t);
  const handle = await startCodexAcpProcess({ ...options,
    adapterPath: process.env.FULI_TEST_CODEX_ACP_ADAPTER, codexPath: process.env.FULI_TEST_CODEX_BINARY,
    initializeTimeoutMs: 20_000, stopTimeoutMs: 10_000 });
  assert.equal(handle.initialization.protocolVersion, 1);
  assert.ok(handle.ownedPids.length >= 2, 'adapter and actual app-server ownership must both be captured');
  t.diagnostic(JSON.stringify({ initialization: handle.initialization, authentication: handle.authentication,
    ownedProcesses: handle.ownedPids.length }));
  await handle.close(); await handle.closed;
  assert.equal(handle.signal.aborted, true);
  assert.ok(handle.ownedPids.every(gone));
  assert.deepEqual(handle.pendingPermissions, []);
});
