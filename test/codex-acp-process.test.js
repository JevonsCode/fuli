import assert from 'node:assert/strict';
import test from 'node:test';
import fsPromises, { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { startCodexAcpProcess } from '../src/agents/codex/acp-process.js';
import { createCodexAcpWorkerAdapter } from '../src/agents/codex/acp-worker.js';
import { createWorkerRunAttempt } from '../src/graphiti/worker-run-host.js';
import { inspectWindowsNativeProcess, stopWindowsNativeProcess } from '../src/native-runtime/windows-processes.js';

const secret = 'SYNTHETIC_PRIVATE_VALUE_NEVER_LOG';
const windowsOnly = { skip: process.platform !== 'win32' };
async function fixture(t, mode = 'success') {
  // Real path: a runner's temp dir can be a short (8.3) name the adapter never sees.
  const root = await fsPromises.realpath(await mkdtemp(join(tmpdir(), 'fuli ACP process ')));
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
  if(mode==='auth-never')return;
  const publish=()=>send({jsonrpc:'2.0',method:'_auth/status_update',params:{authStatus:{
    kind:mode==='worker-host'||mode==='auth-gated-account'?'account':'none',account:{email:secret}}}});
  if(mode.startsWith('auth-gated-')){
    let published=false;
    const watcher=fs.watch(require('node:path').dirname(record),()=>{
      if(!published&&fs.existsSync(record+'.auth')){published=true;watcher.close();publish();}
    });
  }else publish();
}
input.on('close',()=>{if(mode!=='hang')process.exit(0);});
`);
  // Startup keeps the product's initialize budget: the owned job helper compiles
  // C# in PowerShell, which a parallel suite can slow past a few seconds.
  return { root, record, options: { adapterPath, codexPath: process.execPath, codexHome, cwd,
    stopTimeoutMs: 8000,
    env: { ...process.env, CODEX_THREAD_ID: secret, OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret,
      DEFAULT_AUTH_REQUEST: secret, CODEX_CONFIG: secret, APP_SERVER_LOGS: secret,
      NODE_OPTIONS: '--this-must-be-removed', NODE_PATH: secret, MODEL_PROVIDER: secret } } };
}
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
// The adapter rewrites its record on every method, so a torn read is retried.
async function recordedMethod(record, method, timeoutMs = 15_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await delay(25)) {
    const observed = await readFile(record, 'utf8').then(JSON.parse).catch(() => null);
    if (observed?.methods.includes(method)) return;
  }
  throw new Error(`The synthetic adapter never received ${method}`);
}
const trust = options => writeFile(join(options.codexHome, 'config.toml'),
  '[projects.' + JSON.stringify(options.cwd) + ']\ntrust_level = "trusted"\n');

test('ACP authentication waits for a later trusted account or none notification without another initialize', windowsOnly, async t => {
  for (const kind of ['account', 'none']) {
    const { options, record } = await fixture(t, `auth-gated-${kind}`);
    const handle = await startCodexAcpProcess(options);
    try {
      assert.equal(handle.authentication, 'unknown');
      const listeners = getEventListeners(handle.signal, 'abort').length;
      const waiting = handle.waitForAuthentication({ timeoutMs: 3000 });
      await writeFile(record + '.auth', 'Publish the synthetic notification.');
      assert.equal(await waiting, kind);
      assert.equal(handle.authentication, kind);
      assert.equal(await handle.waitForAuthentication({ timeoutMs: 1 }), kind);
      assert.equal(getEventListeners(handle.signal, 'abort').length, listeners);
      assert.deepEqual(JSON.parse(await readFile(record, 'utf8')).methods, ['initialize']);
    } finally { await handle.close(); }
    assert.ok(handle.ownedPids.every(gone));
  }
});

test('ACP unobserved authentication times out distinctly and cancel or close interrupts with owned cleanup', windowsOnly, async t => {
  for (const kind of ['timeout', 'cancel', 'signal', 'close']) {
    const { options, record } = await fixture(t, 'auth-never');
    const handle = await startCodexAcpProcess(options);
    const controller = new AbortController();
    try {
      const waiting = handle.waitForAuthentication({ timeoutMs: kind === 'timeout' ? 10 : 3000, signal: controller.signal });
      const rejected = assert.rejects(waiting, error => {
        assert.equal(error.code, kind === 'timeout' ? 'acp_authentication_timeout'
          : kind === 'close' ? 'acp_closed' : 'acp_cancelled');
        assert.equal((error.stack + JSON.stringify(error)).includes(secret), false);
        return true;
      });
      if (kind === 'cancel') await handle.cancel();
      if (kind === 'close') await handle.close();
      if (kind === 'signal') controller.abort(new Error(secret));
      await rejected; await handle.closed;
      assert.equal(handle.authentication, 'unknown');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(getEventListeners(handle.signal, 'abort').length, 0);
      assert.ok(handle.ownedPids.every(gone));
      assert.deepEqual(JSON.parse(await readFile(record, 'utf8')).methods, ['initialize']);
    } finally { await handle.close(); }
  }
});

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

test('host connects one synthetic ACP process to a mocked Provider WorkerRun and verifies the child result', windowsOnly, async t => {
  const { options, record, root } = await fixture(t, 'worker-host');
  await trust(options);
  const request = { personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project',
    task_context_token: 'fuli-task-parent-fixture-1234', source_application: 'claude_code', task_id: 'task',
    agent_id: 'synthetic-agent', worker_id: 'synthetic-worker', executor_id: 'synthetic-executor',
    target_application: 'codex', provider: 'openai', model: 'gpt-6.1-sol',
    model_strategy: { mode: 'deep', reasoning_effort: 'max', capability_hints: [] }, idempotency_key: 'synthetic-attempt-1234' };
  const context = { personal_space_id: request.personal_space_id, personal_project_id: request.personal_project_id,
    project_agent_id: request.agent_id, token: 'fuli-task-own-fixture-5678', source_application: 'codex',
    session_id: 'synthetic-session', source_session_id: 'synthetic-session', turn_id: 'worker-run:synthetic-run' };
  const run = state => ({ ...request, run_id: 'synthetic-run', state, actual_session_id: 'synthetic-session',
    requested_model_provider: request.provider, requested_model: request.model,
    requested_model_strategy: request.model_strategy });
  const activities = [];
  let authorityReads = 0, dispatches = 0;
  const provider = {
    prepareProjectAgentWorkerRun: async () => run('prepared'),
    claimProjectAgentWorkerStart: async () => ({ ...run('claimed'), start_claimed: true }),
    sealProjectAgentWorkerSession: async (_id, value) => {
      assert.equal(value.session_id, 'synthetic-session'); return run('sealed');
    },
    admitProjectAgentWorkerContext: async () => ({ ...run('admitted'), own_context_token: context.token, task_context: context }),
    getProjectAgentWorkerRun: async () => { authorityReads += 1; return run('admitted'); },
    getTaskContext: async token => {
      if (token === request.task_context_token) return { ...context, token, session_id: 'parent-session', source_application: 'claude_code' };
      assert.equal(token, context.token);
      const observed = JSON.parse(await readFile(record, 'utf8'));
      assert.equal(observed.methods.filter(method => method === 'session/prompt').length, 1);
      return { ...context, checkpoint: { phase: 'complete', work_log: {
        status: 'completed', summary: 'Synthetic child handled one prompt; no real model was invoked.' } } };
    },
    closeProjectAgentWorkerRun: async () => run('closed'),
    dispatchProjectAgentWorkerPrompt: async () => { dispatches += 1; return { dispatch_claimed: true }; },
    recordProjectAgentWorkerResult: async (_id, input) => ({ execution_result: { ...input, retry_eligible: false } }),
    recordProjectAgentTaskActivity: async input => { activities.push(input); }
  };
  const leases = { acquireGraphLease: async () => ({ enabled: false, leaseId: null }),
    releaseLease: async () => ({ released: false }) };
  const adapter = createCodexAcpWorkerAdapter({ ...options, runtimeConfigPath: join(root, 'unused-fixture-runtime.json'),
    startProcess: input => startCodexAcpProcess({ ...input, initializeTimeoutMs: 5000, stopTimeoutMs: 8000 }) });
  const result = await createWorkerRunAttempt({ provider, leases, adapter, request, projectPath: options.cwd,
    taskPrompt: 'Synthetic protocol fixture; do not claim a real model result.',
    pollIntervalMs: 10,
    toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'] }).run();
  assert.equal(result.outcome.status, 'completed', JSON.stringify(result.outcome));
  assert.ok(authorityReads > 0, 'the native process fixture must exercise the authority monitor');
  assert.equal(dispatches, 1, 'the prompt is claimed once before it is sent');
  assert.deepEqual(result.cleanup, { processStopped: true, runClosed: true, errors: [] });
  const observed = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(gone(observed.pid), true);
  const server = observed.sessionRequest.mcpServers[0];
  assert.equal(server.name, 'fuli_worker');
  assert.equal(JSON.stringify(server).includes(request.task_context_token), false);
  assert.equal(JSON.stringify(observed.prompt).includes('FULI_WORKER_DESCRIPTOR'), false);
  assert.equal(activities.at(-1).worker_runtime.session_id, 'synthetic-session');
  assert.equal(activities.at(-1).source_session_id, 'parent-session');
  assert.equal(Object.hasOwn(activities.at(-1), 'actual_model'), false);
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
    let stoppedAt = performance.now();
    // Measure from the adapter's initialize: the job helper's own startup has a
    // separate budget, so a slow helper cannot count against either outcome.
    const cancelled = recordedMethod(record, 'initialize').then(() => {
      stoppedAt = performance.now();
      if (cancel) controller.abort(new Error(secret));
    });
    await assert.rejects(startCodexAcpProcess({ ...options, initializeTimeoutMs: cancel ? 15_000 : 5000,
      signal: controller.signal }), error => {
      assert.equal(error.code, cancel ? 'acp_cancelled' : 'acp_timeout');
      assert.equal((error.stack + JSON.stringify(error)).includes(secret), false);
      return true;
    });
    await cancelled;
    const observed = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(gone(observed.pid), true);
    if (observed.childPid) assert.equal(gone(observed.childPid), true);
    // Within the initialize timeout plus the 10 s stop budget, with margin for a slow runner.
    assert.ok(performance.now() - stoppedAt < 20_000);
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
  const startedAt = new Date().toISOString(), started = performance.now();
  const handle = await startCodexAcpProcess({ ...options,
    adapterPath: process.env.FULI_TEST_CODEX_ACP_ADAPTER, codexPath: process.env.FULI_TEST_CODEX_BINARY,
    initializeTimeoutMs: 20_000, stopTimeoutMs: 10_000 });
  try {
    const initialAuthentication = handle.authentication, initializedMs = Math.round(performance.now() - started);
    assert.equal(handle.initialization.protocolVersion, 1);
    assert.ok(handle.ownedPids.length >= 2, 'adapter and actual app-server ownership must both be captured');
    const authentication = await handle.waitForAuthentication({ timeoutMs: 5000 });
    assert.equal(authentication, 'none');
    t.diagnostic(JSON.stringify({ startedAt, initialization: handle.initialization,
      initialAuthentication, initializedMs, authentication, authenticationMs: Math.round(performance.now() - started),
      authObservedAt: new Date().toISOString(), ownedProcesses: handle.ownedPids.length }));
  } finally { await handle.close(); await handle.closed; }
  assert.equal(handle.signal.aborted, true);
  assert.ok(handle.ownedPids.every(gone));
  assert.deepEqual(handle.pendingPermissions, []);
});
