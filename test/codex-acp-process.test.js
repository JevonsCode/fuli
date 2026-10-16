import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises, { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
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
let model='other-model', effort='high', sessionId='synthetic-session';
const config=()=>[
  {id:'model',name:'Model',type:'select',currentValue:model,
    options:[{value:'other-model',name:'Other'},{value:'gpt-6.1-sol',name:'Target'}]},
  {id:'reasoning_effort',name:'Effort',type:'select',currentValue:effort,
    options:(mode==='session-no-max'?['high']:['high','max']).map(value=>({value,name:value}))}];
const save=()=>fs.writeFileSync(record,JSON.stringify(observed)); save();
process.on('uncaughtException',error=>{observed.adapterFailure={name:error.name,code:error.code};save();process.exit(1);});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
async function startTree(){
  const childCode="const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000) /* FULI_ACP_DETACHED_TEST */'],{stdio:'ignore',windowsHide:true,detached:true});fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,childPid:child.pid}));setInterval(()=>{},1000);";
  const child=spawn(process.env.CODEX_PATH,['-e',childCode,record+'.tree'],{stdio:'ignore',windowsHide:true,detached:true});
  observed.childPid=child.pid;save();
  child.once('error',error=>{observed.childSpawnError=error.code;save();});
  child.once('exit',code=>{observed.childExitCode=code;save();});
  const deadline=Date.now()+5000;
  while(!fs.existsSync(record+'.tree')){
    if(Date.now()>deadline)throw new Error('Synthetic child tree did not become ready');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
process.stderr.write(secret.repeat(6000));
const input=readline.createInterface({input:process.stdin});
input.on('line',async line=>{
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
  }else if(value.method==='session/new'){
    observed.sessionRequest=value.params;save();
    if(mode==='session-hang')await startTree();
    send({jsonrpc:'2.0',id:value.id,result:{sessionId,configOptions:config()}});
  }else if(value.method==='session/set_config_option'){
    if(value.params.configId==='model')model=mode==='session-wrong-model'?'other-model':value.params.value;
    else effort=value.params.value;
    send({jsonrpc:'2.0',id:value.id,result:{configOptions:config()}});
  }else if(value.method==='session/prompt'){
    observed.prompt=value.params;save();
    if(mode==='session-hang')return;
    if(mode==='session-orphan'){
      await startTree(); process.kill(observed.childPid);
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        try{process.kill(observed.childPid,0);}catch{break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      process.kill(JSON.parse(fs.readFileSync(record+'.tree','utf8')).childPid,0);
      observed.grandchildBeforeRootExit=true;save();process.exit(0);
    }
    if(mode==='session-eof'){process.exit(0);}
    const update=(kind,fields)=>send({jsonrpc:'2.0',method:'session/update',params:{
      sessionId:mode==='session-foreign'?'foreign-session':sessionId,update:{sessionUpdate:kind,...fields}}});
    update('agent_thought_chunk',{content:{type:'text',text:secret}});
    update('agent_message_chunk',{content:{type:'text',text:mode==='session-oversize'?secret.repeat(2000):'完成 🧪 中文'}});
    update('tool_call',{toolCallId:'tool-1',title:secret,rawInput:{secret},status:'completed'});
    send({jsonrpc:'2.0',id:value.id,result:{stopReason:'end_turn'}});
  }else if(value.method==='session/cancel'){
    observed.cancelled=true;save();
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
const trust = options => writeFile(join(options.codexHome, 'config.toml'),
  '[projects.' + JSON.stringify(options.cwd) + ']\ntrust_level = "trusted"\n');

test('ACP requires existing cwd trust, locks one session and one exact-model prompt', windowsOnly, async t => {
  const { options, record } = await fixture(t, 'session');
  const handle = await startCodexAcpProcess(options);
  try {
    await assert.rejects(handle.newSession({}), { code: 'acp_directory_untrusted' });
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')).methods, ['initialize']);
    await trust(options);
    await assert.rejects(handle.newSession({ additionalDirectories: [tmpdir()] }), { code: 'acp_invalid_session' });
    const session = await handle.newSession({ mcpServers: [{ name: 'fuli_worker_fixture',
      command: process.execPath, args: ['unused'], env: [{ name: 'FULI_WORKER_DESCRIPTOR', value: secret }] }] });
    assert.equal(session.sessionId, 'synthetic-session');
    await assert.rejects(handle.newSession({}), { code: 'acp_session_already_created' });
    await assert.rejects(handle.promptOnce({ text: 'premature' }), { code: 'acp_model_not_configured' });
    assert.deepEqual(await handle.configureModel({ modelId: 'gpt-6.1-sol', reasoningEffort: 'max' }),
      { modelId: 'gpt-6.1-sol', reasoningEffort: 'max' });
    const result = await handle.promptOnce({ text: 'synthetic request' });
    assert.equal(result.text, '完成 🧪 中文');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.sessionId, session.sessionId);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(result.toolUpdates, [{ toolCallId: 'tool-1', status: 'completed' }]);
    await assert.rejects(handle.promptOnce({ text: 'must not execute twice' }), { code: 'acp_prompt_already_started' });
    const observed = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(observed.sessionRequest.cwd, options.cwd);
    assert.equal(observed.sessionRequest.additionalDirectories, undefined);
    assert.equal(observed.sessionRequest.mcpServers[0].env[0].value, secret);
    assert.equal(observed.methods.filter(method => method === 'session/prompt').length, 1);
  } finally { await handle.close(); }
});

test('ACP refuses unsupported effort and mismatched model acknowledgements before any prompt', windowsOnly, async t => {
  for (const mode of ['session-no-max', 'session-wrong-model']) {
    const { options, record } = await fixture(t, mode);
    await trust(options);
    const handle = await startCodexAcpProcess(options);
    try {
      await handle.newSession({});
      await assert.rejects(handle.configureModel({ modelId: 'gpt-6.1-sol', reasoningEffort: 'max' }),
        { code: mode === 'session-no-max' ? 'acp_model_unavailable' : 'acp_model_mismatch' });
      assert.equal(JSON.parse(await readFile(record, 'utf8')).methods.includes('session/prompt'), false);
    } finally { await handle.close(); }
  }
});

test('ACP close and preemptive cancel prevent a same-tick prompt from reaching the adapter', windowsOnly, async t => {
  for (const cancel of [false, true]) {
    const { options, record } = await fixture(t, 'session');
    await trust(options);
    const handle = await startCodexAcpProcess(options);
    try {
      await handle.newSession({});
      await handle.configureModel({ modelId: 'gpt-6.1-sol', reasoningEffort: 'max' });
      const stopping = cancel ? handle.cancel() : handle.close();
      await assert.rejects(handle.promptOnce({ text: 'must never be dispatched' }),
        { code: cancel ? 'acp_cancelled' : 'acp_closed' });
      await stopping;
      assert.equal(JSON.parse(await readFile(record, 'utf8')).methods.includes('session/prompt'), false);
    } finally { await handle.close(); }
  }
});

test('ACP prompt cancellation and timeout reclaim the verified child tree and preserve unrelated processes', windowsOnly, async t => {
  const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => outsider.kill());
  for (const kind of ['manual', 'signal', 'timeout']) {
    const { options, record } = await fixture(t, 'session-hang');
    await trust(options);
    const handle = await startCodexAcpProcess({ ...options, stopTimeoutMs: 15_000 });
    try {
      await handle.newSession({});
      const tree = JSON.parse(await readFile(record + '.tree', 'utf8'));
      if (kind === 'manual') {
        const direct = await inspectWindowsNativeProcess(handle.pid, { children: true });
        const descendants = await inspectWindowsNativeProcess(handle.pid, { descendants: true });
        assert.equal(direct.some(row => row.pid === tree.pid), true);
        assert.equal(direct.some(row => row.pid === tree.childPid), false);
        assert.equal(descendants.some(row => row.pid === tree.childPid && row.parentPid === tree.pid), true);
      }
      await handle.configureModel({ modelId: 'gpt-6.1-sol', reasoningEffort: 'max' });
      const controller = new AbortController();
      const pending = handle.promptOnce({ text: 'synthetic hung prompt', signal: controller.signal,
        timeoutMs: kind === 'manual' ? 1 : kind === 'timeout' ? 2500 : 10_000 });
      const rejected = assert.rejects(pending, error => {
        assert.equal(error.code, kind === 'timeout' ? 'acp_timeout' : 'acp_cancelled');
        assert.equal((error.stack + JSON.stringify(error)).includes(secret), false);
        return true;
      });
      if (kind === 'manual') await Promise.all([handle.cancel(), handle.cancel()]);
      if (kind === 'signal') controller.abort(new Error(secret));
      await rejected; await handle.closed;
      assert.equal(gone(handle.pid), true);
      assert.equal(gone(tree.pid), true);
      assert.equal(gone(tree.childPid), true);
      assert.equal(gone(outsider.pid), false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      if (kind !== 'timeout') assert.equal(JSON.parse(await readFile(record, 'utf8')).cancelled, true);
    } finally { await handle.close(); }
  }
});

test('ACP job reclaims a detached grandchild after its intermediate parent and adapter exit', windowsOnly, async t => {
  const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => outsider.kill());
  const { options, record } = await fixture(t, 'session-orphan');
  await trust(options);
  const handle = await startCodexAcpProcess(options);
  let tree;
  try {
    await handle.newSession({});
    await handle.configureModel({ modelId: 'gpt-6.1-sol', reasoningEffort: 'max' });
    await assert.rejects(handle.promptOnce({ text: 'synthetic detached orphan' }), { code: 'acp_closed' });
    tree = JSON.parse(await readFile(record + '.tree', 'utf8'));
    assert.equal(JSON.parse(await readFile(record, 'utf8')).grandchildBeforeRootExit, true,
      'the detached grandchild must survive its intermediate parent before adapter exit');
    await handle.closed;
    assert.equal(gone(tree.pid), true);
    assert.equal(gone(tree.childPid), true, 'clean shutdown requires the detached grandchild to exit');
    assert.equal(gone(outsider.pid), false);
  } finally {
    await handle.close().catch(() => {});
    // Keep a failing regression from leaking its own marked synthetic process.
    tree ??= await readFile(record + '.tree', 'utf8').then(JSON.parse).catch(() => null);
    const owner = tree && await inspectWindowsNativeProcess(tree.childPid);
    if (owner) {
      assert.ok(owner.commandLine.includes('FULI_ACP_DETACHED_TEST'));
      await stopWindowsNativeProcess(owner.pid, { pid: owner.pid, command: owner.executable, ownership: owner }, { timeoutMs: 8000 });
    }
  }
});

test('ACP foreign session updates, oversized output and prompt EOF fail closed without raw SDK logging', windowsOnly, async t => {
  const errors = [], spy = t.mock.method(console, 'error', (...args) => errors.push(args));
  try {
    for (const mode of ['session-foreign', 'session-oversize', 'session-eof']) {
      const { options } = await fixture(t, mode);
      await trust(options);
      const handle = await startCodexAcpProcess(options);
      try {
        await handle.newSession({});
        await handle.configureModel({ modelId: 'gpt-6.1-sol', reasoningEffort: 'max' });
        await assert.rejects(handle.promptOnce({ text: 'synthetic request' }), error => {
          assert.ok(['acp_protocol_error', 'acp_closed', 'acp_output_limit'].includes(error.code));
          assert.equal((error.stack + JSON.stringify(error)).includes(secret), false);
          return true;
        });
      } finally { await handle.close(); }
    }
    assert.deepEqual(errors, []);
  } finally { spy.mock.restore(); }
});

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

test('ACP one-millisecond initialization timeout cleans startup before rejecting', windowsOnly, async t => {
  const { options, record } = await fixture(t);
  let observed;
  try {
    await assert.rejects(startCodexAcpProcess({ ...options, initializeTimeoutMs: 1 }), { code: 'acp_timeout' });
    observed = await readFile(record, 'utf8').then(JSON.parse).catch(() => null);
    // The helper can observe expiry before launching the adapter. If execution
    // began, rejection still waits for the owned job to be empty.
    if (observed) assert.equal(gone(observed.pid), true, 'timeout rejection must wait for process cleanup');
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
