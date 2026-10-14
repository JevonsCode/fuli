import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { jsonLifecycleOutput as run, unavailableOutput } from '../src/agents/json-hooks/lifecycle.js';
const receipt = 'FULI Agent：负责人 [Test Agent](<http://localhost/agents/test>)';
const input = {session_id:'session-a',run_id:'turn-a',cwd:'/workspace/example',prompt:'hello'};
function fixture() {
  let state;
  const calls = [];
  const deps = {
    invoke: async (name, args) => { calls.push({name,args}); return name === 'begin_task_context' ? {taskContextToken:'token-a',agent_receipt:{required:true,markdown:receipt},effective_preferences:[]} : {status:'checkpointed'}; },
    readState: async () => state,
    writeState: async value => { state=value; },
    formatContext: value => JSON.stringify(value)
  };
  return {deps,calls,get state(){return state;}};
}
test('injects flat context and preserves real host session and turn identity', async () => {
  const f=fixture(); const out=await run('UserPromptSubmit',input,f.deps);
  assert.ok(out.additionalContext.includes(receipt));
  assert.ok(out.additionalContext.includes('checkpoint_task_knowledge'));
  assert.deepEqual(f.calls[0].args,{sessionId:'session-a',turnId:'turn-a',projectPath:input.cwd,taskPrompt:'hello',sourceApplication:'other',sourceSessionId:'session-a'});
  assert.equal(f.state.receipt,receipt);
  assert.equal(JSON.stringify(f.state).includes('hello'),false);
});
test('blocks a missing receipt even when checkpoint was saved',async()=>{
  const f=fixture(); await run('UserPromptSubmit',input,f.deps);
  const out=await run('Stop',{...input,last_assistant_message:'done'},f.deps);
  assert.equal(out.decision,'block'); assert.ok(out.reason.includes(receipt));
});
test('allows a completed checkpoint and exact receipt once',async()=>{
  const f=fixture(); await run('UserPromptSubmit',input,f.deps);
  assert.deepEqual(await run('Stop',{...input,last_assistant_message:`done\n${receipt}`},f.deps),{});
});
test('blocks duplicate receipts and a missing checkpoint',async()=>{
  const f=fixture(); await run('UserPromptSubmit',input,f.deps);
  assert.equal((await run('Stop',{...input,last_assistant_message:receipt+'\n'+receipt},f.deps)).decision,'block');
  f.deps.invoke=async()=>({status:'checkpoint_required',decision:'block',task_context_token:'token-a'});
  assert.match((await run('Stop',{...input,last_assistant_message:receipt},f.deps)).reason,/checkpoint_task_knowledge/);
});
test('never reuses a receipt from another run or a superseding task',async()=>{
  const f=fixture(); await run('UserPromptSubmit',input,f.deps);
  const out=await run('Stop',{...input,run_id:'turn-b',last_assistant_message:receipt},f.deps);
  assert.equal(out.decision,'block'); assert.equal(out.reason.includes(receipt),false);
  f.deps.invoke=async()=>({status:'checkpoint_required',task_context_token:'another-token'});
  assert.equal((await run('Stop',{...input,last_assistant_message:receipt},f.deps)).reason.includes('another-token'),false);
});
test('checkpoint result supersedes entry receipt only for the same token',async()=>{
  const f=fixture(); await run('UserPromptSubmit',input,f.deps);
  const finalReceipt=receipt+' · 协作 [Helper](<http://localhost/agents/helper>)';
  const post={...input,tool_name:'mcp__fuli__checkpoint_task_knowledge',tool_input:{taskContextToken:'token-a'},tool_response:JSON.stringify({content:[{type:'text',text:JSON.stringify({agent_receipt:{required:true,markdown:finalReceipt}})}]})};
  await run('PostToolUse',{...post,tool_input:{taskContextToken:'wrong'}},f.deps);
  assert.equal(f.state.receipt,receipt);
  await run('PostToolUse',post,f.deps); assert.equal(f.state.receipt,finalReceipt);
  assert.equal((await run('Stop',{...input,last_assistant_message:receipt},f.deps)).decision,'block');
});
test('subagents cannot replace the main run identity',async()=>{
  const f=fixture(); assert.deepEqual(await run('UserPromptSubmit',{...input,subagent:true},f.deps),{}); assert.equal(f.calls.length,0);
});
test('invalid host identifiers do not call Fuli',async()=>{
  const f=fixture(); await assert.rejects(run('UserPromptSubmit',{...input,run_id:''},f.deps)); assert.equal(f.calls.length,0);
});
test('failed entry invalidates old receipt and output budget never drops instructions silently',async()=>{
  const f=fixture(); await run('UserPromptSubmit',input,f.deps);
  f.deps.formatContext=()=> 'a'.repeat(70*1024);
  await assert.rejects(run('UserPromptSubmit',{...input,run_id:'turn-b'},f.deps),/limit/);
  assert.equal(f.state.token,undefined); assert.equal(f.state.receipt,undefined);
});
test('unavailability is explicit and does not trap the host in a correction loop',()=>{
  const entry=unavailableOutput('UserPromptSubmit'); assert.match(entry.additionalContext,/未验证/);
  const stop=unavailableOutput('Stop',{last_assistant_message:'done'}); assert.equal(stop.decision,'block');
  assert.deepEqual(unavailableOutput('Stop',{last_assistant_message:stop.reason}),{});
});
test('unavailability does not accept a stale owner alongside its warning',()=>{
  const warning=unavailableOutput('Stop').reason;
  assert.equal(unavailableOutput('Stop',{last_assistant_message:receipt+'\n'+warning}).decision,'block');
});
test('CLI emits one flat JSON warning and no local diagnostics on runtime failure',()=>{
  const result=spawnSync(process.execPath,['src/agents/json-hooks/cli.js','--runtime-root','/nonexistent-jvs-a-runtime','--client-id','jvs-a-test'],{
    input:JSON.stringify({...input,hook_event_name:'UserPromptSubmit'}),encoding:'utf8'
  });
  assert.equal(result.status,0); assert.equal(result.stderr,'');
  const output=JSON.parse(result.stdout);
  assert.match(output.additionalContext,/未验证/);
  assert.equal(result.stdout.includes('nonexistent-jvs-a-runtime'),false);
});
