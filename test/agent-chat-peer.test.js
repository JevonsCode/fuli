import assert from 'node:assert/strict';
import test from 'node:test';
import { sign } from 'node:crypto';
import { canonicalJson } from '../packages/roundtable/src/peer/protocol.js';
import { device, pair } from './fixtures/peer-devices.js';

test('paired devices discover an explicitly shared member and exchange a group over real mTLS without waking anything', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    await beta.runtime.setShares({ shares: [
      { projectId: beta.projectId, clients: ['codex'] },
      { projectId: beta.projectId, agentId: 'beta-member', communicationOnly: true, clients: [] }
    ] });
    const found = await alpha.app.roundtable.findAgents({ occupation: 'tester', capability: 'testing' });
    assert.equal(found.remoteAgents.length, 1);
    const target = found.remoteAgents[0];
    assert.equal(target.agentId, 'beta-member');
    assert.equal(target.communicationOnly, true);
    assert.equal(target.occupation, 'tester');
    assert.equal(target.projectId, beta.projectId);
    const call = (d, actor, action, data = {}) => d.app.roundtable.chat({ taskContextToken: `${actor}-task`, sourceApplication: 'codex', action, ...data });
    const room = await call(alpha, 'alpha', 'create', { requestId: 'group-1', kind: 'group', title: 'cross device', members: [target.address] });
    assert.equal(room.transport, 'peer');
    const sent = await call(alpha, 'alpha', 'send', { chatId: room.chatId, requestId: 'message-1', body: 'review this' });
    assert.equal(sent.seq, 1);
    const received = await call(beta, 'beta-member', 'read', { chatId: room.chatId });
    assert.equal(received.messages[0].body, 'review this');
    await call(beta, 'beta-member', 'send', { chatId: room.chatId, requestId: 'reply-1', body: 'reviewed' });
    assert.deepEqual((await call(alpha, 'alpha', 'read', { chatId: room.chatId })).messages.map(m => m.body), ['review this', 'reviewed']);
    assert.equal((await alpha.app.roundtable.chatOwner({ action: 'list' })).chats.length, 1);
    await assert.rejects(call(beta, 'beta', 'read', { chatId: room.chatId }), /member|not found/);
    assert.equal(alpha.calls.wakes.length + beta.calls.wakes.length, 0);
    assert.equal(alpha.calls.grants.length + beta.calls.grants.length, 0);
    assert.ok(alpha.calls.origins.every(input => input.purpose === 'chat'));
    assert.ok(!JSON.stringify(beta.calls).includes('alpha-task'));
    await assert.rejects(alpha.app.peer.resolveRemote(target.address), /communication|chat/i);
    await beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['codex'] }] });
    await assert.rejects(call(beta, 'beta-member', 'read', { chatId: room.chatId }), /share/i);
  } finally { await alpha.close(); await beta.close(); }
});

test('a signed device cannot use a forged origin for chat', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha', { tamper: (_proof, claims) => ({
    payload: Buffer.from(JSON.stringify({ ...claims, purpose: 'execution' })).toString('base64url'), signature: 'AA'
  }) }), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    const target = (await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    await assert.rejects(alpha.app.roundtable.chat({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      action: 'create', requestId: 'bad-proof', kind: 'direct', members: [target] }), /origin|proof/i);
    assert.equal((await beta.app.roundtable.chatOwner({ action: 'list' })).chats.length, 0);
  } finally { await alpha.close(); await beta.close(); }
});

test('valid signatures cannot exchange chat and execution proof versions', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha', { tamper: (_proof, claims, authority) => {
    const chat = claims.purpose !== 'chat';
    const payload = Buffer.from(canonicalJson({ ...claims, purpose: chat ? 'chat' : 'execution',
      version: chat ? 'fuli-chat-origin/1' : 'fuli-remote-origin/1' }));
    return { payload: payload.toString('base64url'), signature: sign(null, payload, authority.privateKey).toString('base64url') };
  } }), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    const target = (await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    await assert.rejects(alpha.app.roundtable.chat({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      action: 'create', requestId: 'wrong-version', kind: 'direct', members: [target] }), /origin|purpose/i);
    const execution = await alpha.app.roundtable.messageAgent({ taskContextToken: 'alpha-task', sourceApplication: 'codex',
      to: target, body: 'A chat proof cannot wake a process', timeoutSeconds: 30 });
    assert.equal(execution.status, 'failed');
    assert.equal(beta.calls.wakes.length, 0);
    assert.equal(beta.calls.grants.length, 0);
  } finally { await alpha.close(); await beta.close(); }
});

test('paired chat uses the same wait cursor for ten bidirectional rounds over mTLS', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    await beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['codex'] }] });
    const target = (await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    const a = (action, data) => alpha.app.roundtable.chat({ taskContextToken: 'alpha-task', sourceApplication: 'codex', action, ...data });
    const b = (action, data) => beta.app.roundtable.chat({ taskContextToken: 'beta-task', sourceApplication: 'codex', action, ...data });
    const { chatId } = await a('create', { requestId: 'wait-peer', kind: 'direct', members: [target] });
    let after = 0;
    for (let i = 0; i < 10; i++) {
      for (const [send, receive, who] of [[a,b,'a'],[b,a,'b']]) {
        const waiting = receive('wait', { chatId, after, timeoutSeconds: 15 });
        await send('send', { chatId, requestId: `${who}-${i}`, body: `${who}:${i}` });
        const page = await waiting;
        assert.deepEqual(page.messages.map(m => m.body), [`${who}:${i}`]);
        after = page.nextAfter;
      }
    }
    assert.equal(after, 20);
    assert.equal(alpha.calls.wakes.length + beta.calls.wakes.length, 0);
  } finally { await alpha.close(); await beta.close(); }
});

test('paired owner notifications deliver metadata only and resume from durable history', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  let stop;
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    await beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['codex'] }] });
    const target = (await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    const a = (action, data) => alpha.app.roundtable.chat({ taskContextToken: 'alpha-task', sourceApplication: 'codex', action, ...data });
    const { chatId } = await a('create', { requestId: 'updates-room', kind: 'direct', members: [target] });
    await a('send', { chatId, requestId: 'updates-send', body: 'not in notifications' });
    const received = Promise.withResolvers();
    stop = beta.app.peer.subscribeChatUpdates((event, error) => {
      if (error) received.reject(error);
      else if (event?.seq === 1) received.resolve(event);
    });
    assert.deepEqual(await received.promise, { chatId, seq: 1 });
  } finally { stop?.(); await alpha.close(); await beta.close(); }
});

test('a pending signed wait cannot consume messages after its sharing is revoked', { timeout: 20_000 }, async () => {
  const [alpha, beta] = await Promise.all([device('alpha'), device('beta')]);
  try {
    await pair(alpha, beta);
    await alpha.runtime.setShares({ shares: [{ projectId: alpha.projectId, clients: ['codex'] }] });
    await beta.runtime.setShares({ shares: [{ projectId: beta.projectId, clients: ['codex'] }] });
    const target = (await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    const a = (action, data) => alpha.app.roundtable.chat({ taskContextToken: 'alpha-task', sourceApplication: 'codex', action, ...data });
    const { chatId } = await a('create', { requestId: 'revoke-room', kind: 'direct', members: [target] });
    const waiting = beta.app.roundtable.chat({ taskContextToken: 'beta-task', sourceApplication: 'codex', action: 'wait', chatId, timeoutSeconds: 15 });
    const denied = assert.rejects(waiting, /share|sharing|revoked/i);
    await beta.runtime.setShares({ shares: [] });
    await a('send', { chatId, requestId: 'revoked-send', body: 'private after revoke' });
    await denied;
  } finally { await alpha.close(); await beta.close(); }
});

test('an offline executable shared lead wakes read-only from its chat snapshot over mTLS', { timeout: 20_000 }, async () => {
  const entered=Promise.withResolvers();
  const [alpha,beta]=await Promise.all([device('alpha'),device('beta',{wake:async input=>{
    entered.resolve(input); return {body:'read-only remote answer',sessionId:'beta-chat-wake'};
  }})]);
  try {
    await pair(alpha,beta);
    await alpha.runtime.setShares({shares:[{projectId:alpha.projectId,clients:['codex']}]});
    const target=(await alpha.app.roundtable.findAgents({})).remoteAgents[0].address;
    const call=(action,data)=>alpha.app.roundtable.chat({taskContextToken:'alpha-task',sourceApplication:'codex',action,...data});
    const {chatId}=await call('create',{requestId:'remote-wake-room',kind:'direct',members:[target]});
    await call('send',{chatId,requestId:'remote-wake-send',body:'remote unread message'});
    const input=await entered.promise;
    assert.match(input.prompt,/remote unread message/);
    assert.match(input.prompt,/nextAfter/);
    assert.equal(beta.calls.wakes.length,1);
    assert.equal(beta.calls.grants.length,1);
    assert.ok(!JSON.stringify(input).includes(alpha.folder));
  } finally { await alpha.close(); await beta.close(); }
});

test('concurrent paired senders serialize snapshots without consuming a message twice', { timeout: 20_000 }, async () => {
  const first=Promise.withResolvers(),firstEntered=Promise.withResolvers(),secondEntered=Promise.withResolvers();let runs=0;
  const [alpha,beta,gamma]=await Promise.all([device('alpha'),device('beta',{wake:async input=>{
    runs++;if(runs===1){firstEntered.resolve();await first.promise;}else secondEntered.resolve();
    return {body:'answer',sessionId:`beta-${runs}`};
  }}),device('gamma')]);
  try {
    await pair(alpha,beta);
    const {invitation}=alpha.runtime.createInvitation();await gamma.runtime.join({invitation,name:'Third'});
    for(const d of [alpha,gamma])await d.runtime.setShares({shares:[{projectId:d.projectId,clients:['codex'],workingDirectory:d.folder}]});
    const found=(await alpha.app.roundtable.findAgents({})).remoteAgents;
    const b=found.find(a=>a.agentId==='beta-lead').address,c=found.find(a=>a.agentId==='gamma-lead').address;
    const call=(d,token,action,data)=>d.app.roundtable.chat({taskContextToken:token,sourceApplication:'codex',action,...data});
    const {chatId}=await call(alpha,'alpha-task','create',{requestId:'multi-sender',kind:'group',members:[b,c]});
    await call(alpha,'alpha-task','send',{chatId,requestId:'first',body:`@{${b}} FIRST`});await firstEntered.promise;
    await call(gamma,'gamma-task','send',{chatId,requestId:'second',body:`@{${b}} SECOND`});
    first.resolve();await secondEntered.promise;
    const {setTimeout:delay}=await import('node:timers/promises');await delay(1200); // Allow queued claims/results, never inbox polling.
    assert.equal(beta.calls.wakes.length,2);
    assert.deepEqual(beta.calls.wakes.map(w=>[w.prompt.includes('FIRST'),w.prompt.includes('SECOND')]),[[true,false],[false,true]]);
  }finally{first.resolve();await gamma.close();await beta.close();await alpha.close();}
});

test('a new member wake cannot reveal or acknowledge the target older unread history', { timeout: 20_000 }, async () => {
  const entered=Promise.withResolvers();
  const [alpha,beta,gamma]=await Promise.all([device('alpha'),device('beta',{wake:async input=>{
    entered.resolve(input);return{body:'answer',sessionId:'gap-answer'};
  }}),device('gamma')]);
  try {
    await pair(alpha,beta);const {invitation}=alpha.runtime.createInvitation();await gamma.runtime.join({invitation,name:'Third'});
    for(const d of [alpha,gamma])await d.runtime.setShares({shares:[{projectId:d.projectId,clients:['codex'],workingDirectory:d.folder}]});
    const found=(await alpha.app.roundtable.findAgents({})).remoteAgents;
    const b=found.find(a=>a.agentId==='beta-lead').address,c=found.find(a=>a.agentId==='gamma-lead').address;
    const call=(d,token,action,data)=>d.app.roundtable.chat({taskContextToken:token,sourceApplication:'codex',action,...data});
    const room=await call(alpha,'alpha-task','create',{requestId:'gap-room',kind:'group',members:[b]});
    await call(alpha,'alpha-task','send',{chatId:room.chatId,requestId:'old',body:'OLD PRIVATE UNREAD'});
    await call(alpha,'alpha-task','members',{chatId:room.chatId,expectedRevision:room.revision,add:[c]});
    await call(gamma,'gamma-task','send',{chatId:room.chatId,requestId:'new',body:`@{${b}} NEW VISIBLE`});
    const wake=await entered.promise;assert.doesNotMatch(wake.prompt,/OLD PRIVATE UNREAD/);assert.match(wake.prompt,/NEW VISIBLE/);
    const {setTimeout:delay}=await import('node:timers/promises');await delay(700);
    const snapshot=await alpha.app.peer.chatWakeSnapshot({request:{action:'wake_snapshot',chatId:room.chatId,to:b},
      taskContextToken:'alpha-task',sourceApplication:'codex',agentId:'alpha-lead',projectId:alpha.projectId,name:'alpha lead'});
    assert.deepEqual(snapshot.messages.map(m=>m.body),['OLD PRIVATE UNREAD']);
    assert.equal(snapshot.nextAfter,1);assert.equal(beta.calls.wakes.length,1);
  }finally{await gamma.close();await beta.close();await alpha.close();}
});
