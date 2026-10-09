import test from 'node:test';
import { newRoom } from '../src/roundtables/domain.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRoundtableService } from '../src/roundtables/service.js';

const OWNER = Object.freeze({ kind: 'owner' });
const seats = () => [{ id: 'a', name: 'Moderator', role: 'moderator', runtime: 'mcp' }, { id: 'b', name: 'Specialist', role: 'specialist', runtime: 'mcp' }];
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-roundtable-'));
  const databasePath = join(directory, 'collaboration.sqlite');
  let timestamp = 10_000;
  const service = createRoundtableService({ databasePath, clock: () => timestamp, ...options });
  const services = [service];
  t.after(() => { for (const connection of services) connection.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, databasePath, services, advance(ms) { timestamp += ms; }, clock: () => timestamp };
}
function create(service, input = {}) { return service.create({ goal: 'Compare evidence and deliver a result', seats: seats(), limits: { maxRounds: 1 }, ...input }, OWNER); }
function participant(service, roomId, seatId, sourceSessionId = `${seatId}-session`, expiresInMs) {
  const invitation = service.invite({ roomId, seatId, expiresInMs }, OWNER);
  const actor = service.authenticate({ roomId, seatToken: invitation.seatToken, sourceApplication: 'mcp-client', sourceSessionId });
  service.join({ roomId }, actor);
  return { actor, invitation };
}
function start(service, roomId, seatList = ['a', 'b']) {
  const clients = Object.fromEntries(seatList.map(id => [id, participant(service, roomId, id)]));
  service.control({ roomId, action: 'start' }, OWNER);
  return clients;
}
function submit(service, roomId, actor, input = {}) {
  const claim = service.claim({ roomId }, actor);
  assert.ok(claim, 'own current turn can be claimed');
  const evidence = claim.context.phase === 'implementation' ? { artifacts: [`artifact:${claim.attemptId}`] } : claim.context.phase === 'review' ? { verification: { passed: true } } : {};
  return service.submit({ roomId, ...claim, context: undefined, idempotencyKey: claim.attemptId, body: 'Evidence-backed final response', ...evidence, ...input }, actor);
}
function rejectsCode(work, code) { assert.throws(work, error => error.code === code); }

test('standalone scopes are explicit and creation idempotency detects changed payload', t => {
  const { service } = fixture(t);
  const room = create(service, { idempotencyKey: 'create-1' });
  assert.equal(room.room.scope.kind, 'temporary');
  assert.equal(room.room.seats[0].identityKind, 'standalone');
  assert.deepEqual(create(service, { idempotencyKey: 'create-1' }), room);
  rejectsCode(() => create(service, { idempotencyKey: 'create-1', goal: 'Changed' }), 'idempotency_conflict');
  rejectsCode(() => create(service, { limits: { maxRounds: 4 } }), 'invalid_limits');
});

test('capabilities isolate rooms and seats, persist only hashes, and revoke existing actors immediately', t => {
  const { service, databasePath } = fixture(t);
  const first = create(service).room.id, second = create(service).room.id;
  const client = participant(service, first, 'a');
  rejectsCode(() => service.authenticate({ roomId: second, seatToken: client.invitation.seatToken, sourceApplication: 'mcp', sourceSessionId: 's' }), 'invite_invalid');
  rejectsCode(() => service.read({ roomId: second }, client.actor), 'seat_forbidden');
  rejectsCode(() => service.join({ roomId: first, seatId: 'b' }, client.actor), 'seat_forbidden');
  rejectsCode(() => service.invite({ roomId: first, seatId: 'b' }, client.actor), 'owner_required');
  rejectsCode(() => service.control({ roomId: first, action: 'start' }, client.actor), 'owner_required');
  rejectsCode(() => service.read({ roomId: first }, { ...client.actor }), 'seat_forbidden');
  assert.equal(readFileSync(databasePath).includes(Buffer.from(client.invitation.seatToken)), false);
  for (const suffix of ['-wal']) assert.equal(readFileSync(databasePath + suffix).includes(Buffer.from(client.invitation.seatToken)), false);
  service.revoke({ roomId: first, invitationId: client.invitation.invitationId }, OWNER);
  rejectsCode(() => service.read({ roomId: first }, client.actor), 'invite_invalid');
});

test('invitation expiry is checked again on every participant action', t => {
  const { service, advance } = fixture(t);
  const roomId = create(service).room.id;
  const { actor } = participant(service, roomId, 'a', 'a-session', 1000);
  advance(1000);
  rejectsCode(() => service.read({ roomId }, actor), 'invite_invalid');
  rejectsCode(() => service.claim({ roomId }, actor), 'invite_invalid');
});

test('ordered turn claims and final submission are atomic and idempotent', t => {
  const { service } = fixture(t), roomId = create(service).room.id;
  const clients = start(service, roomId);
  assert.equal(service.claim({ roomId }, clients.b.actor), null);
  const claim = service.claim({ roomId }, clients.a.actor);
  assert.equal(claim.context.seat.id, 'a');
  assert.equal(claim.context.scope.kind, 'temporary');
  assert.equal(service.claim({ roomId }, clients.a.actor), null);
  const input = { roomId, turnId: claim.turnId, attemptId: claim.attemptId, fence: claim.fence, idempotencyKey: claim.attemptId, body: 'Proposal' };
  rejectsCode(() => service.submit(input, clients.b.actor), 'seat_forbidden');
  const first = service.submit(input, clients.a.actor);
  assert.deepEqual(service.submit(input, clients.a.actor), first);
  rejectsCode(() => service.submit({ ...input, body: 'Different proposal' }, clients.a.actor), 'idempotency_conflict');
  submit(service, roomId, clients.b.actor, { body: 'Review the proposal' });
  assert.equal(service.read({ roomId }, OWNER).room.phase, 'synthesis');
  const final = submit(service, roomId, clients.a.actor, { body: 'Synthesis', dissent: ['Alternative retained'], actual: { model: 'actual-model', usage: { inputTokens: 20, outputTokens: 4 } } });
  assert.equal(final.room.status, 'concluded');
  assert.equal(final.outcome.acceptance, 'pending');
  assert.equal(final.message.actual.provenance, 'participant_reported');
  assert.equal(final.outcome.verification.confirmed, false);
  const history = service.read({ roomId, limit: 2 }, OWNER);
  assert.deepEqual(history.messages.map(m => m.seq), [1, 2]);
  assert.equal(history.hasMore, true);
  assert.equal(service.read({ roomId, afterSeq: history.nextCursor }, OWNER).messages[0].body, 'Synthesis');
  rejectsCode(() => service.addHumanMessage({ roomId, body: 'late' }, OWNER), 'terminal_room');
  rejectsCode(() => service.control({ roomId, action: 'resume' }, OWNER), 'terminal_room');
});

test('expired fences preserve stale evidence and require explicit bounded retry', t => {
  const { service, advance } = fixture(t), roomId = create(service, { limits: { maxRounds: 1, turnTimeoutMs: 1000 } }).room.id;
  const clients = start(service, roomId), claim = service.claim({ roomId }, clients.a.actor);
  advance(1000);
  const input = { roomId, turnId: claim.turnId, attemptId: claim.attemptId, fence: claim.fence, idempotencyKey: claim.attemptId, body: 'Late result' };
  rejectsCode(() => service.submit(input, clients.a.actor), 'stale_fence');
  const expired = service.read({ roomId }, OWNER);
  assert.equal(expired.room.status, 'paused');
  assert.equal(expired.messages.length, 0);
  assert.equal(expired.attempts[0].status, 'expired');
  assert.equal(expired.attempts[0].lateResult.status, 'stale');
  rejectsCode(() => service.control({ roomId, action: 'resume' }, OWNER), 'retry_required');
  service.control({ roomId, action: 'retry_turn' }, OWNER);
  const retry = service.claim({ roomId }, clients.a.actor);
  assert.notEqual(retry.attemptId, claim.attemptId);
  assert.ok(retry.fence > claim.fence);
  rejectsCode(() => service.submit(input, clients.a.actor), 'stale_fence');
  advance(1000); service.read({ roomId }, OWNER);
  rejectsCode(() => service.control({ roomId, action: 'retry_turn' }, OWNER), 'retry_limit');
});

test('restart recovery invalidates unfinished issuer without invalidating live second connection', t => {
  const f = fixture(t), roomId = create(f.service).room.id, clients = start(f.service, roomId);
  const claim = f.service.claim({ roomId }, clients.a.actor);
  const second = createRoundtableService({ databasePath: f.databasePath, clock: f.clock });
  f.services.push(second);
  assert.equal(second.read({ roomId }, OWNER).currentTurn.status, 'claimed');
  f.service.close();
  const restored = second.read({ roomId }, OWNER);
  assert.equal(restored.room.status, 'paused');
  assert.equal(restored.room.stopReason, 'restart_interrupted');
  assert.equal(restored.attempts[0].status, 'interrupted');
  assert.notEqual(restored.currentTurn.fence, claim.fence);
});

test('CAS controls, human input and pause preserve an accepted current attempt', t => {
  const { service } = fixture(t), roomId = create(service).room.id, clients = start(service, roomId);
  const revision = service.read({ roomId }, OWNER).room.revision;
  const claim = service.claim({ roomId }, clients.a.actor);
  rejectsCode(() => service.control({ roomId, action: 'pause', expectedRevision: revision }, OWNER), 'revision_conflict');
  service.control({ roomId, action: 'pause' }, OWNER);
  service.addHumanMessage({ roomId, body: 'An additional constraint', idempotencyKey: 'human-1' }, OWNER);
  const result = service.submit({ roomId, ...claim, context: undefined, idempotencyKey: claim.attemptId, body: 'Current accepted result' }, clients.a.actor);
  assert.equal(result.room.status, 'paused');
  assert.equal(result.room.agentMessageCount, 1);
  assert.equal(result.currentTurn, null);
  service.control({ roomId, action: 'resume' }, OWNER);
  assert.equal(service.read({ roomId }, OWNER).currentTurn.seatId, 'b');
});

test('message and duration budgets prevent new claims and human input does not consume agent budget', t => {
  const f = fixture(t), roomId = create(f.service, { limits: { maxRounds: 1, maxMessages: 1, maxDurationMs: 1000 } }).room.id;
  const clients = start(f.service, roomId);
  f.service.addHumanMessage({ roomId, body: 'Clarification' }, OWNER);
  const result = submit(f.service, roomId, clients.a.actor);
  assert.equal(result.room.status, 'paused');
  assert.equal(result.room.stopReason, 'message_limit');
  assert.equal(f.service.claim({ roomId }, clients.b.actor), null);
  rejectsCode(() => f.service.control({ roomId, action: 'resume' }, OWNER), 'budget_exhausted');
  f.service.control({ roomId, action: 'update_limits', limits: { maxMessages: 5 } }, OWNER);
  f.advance(1000);
  rejectsCode(() => f.service.control({ roomId, action: 'resume' }, OWNER), 'budget_exhausted');
});

test('collaboration follows planning, dependencies, readonly review and human completion', t => {
  const { service } = fixture(t);
  const roomId = create(service, { mode: 'collaboration', seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'codex', execution: { permission: 'workspace-write', workspace: 'T:/workspace/project' } }, { id: 'r', name: 'Reviewer', role: 'reviewer', runtime: 'claude-code' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r']) submit(service, roomId, clients[id].actor);
  assert.equal(service.read({ roomId }, OWNER).room.phase, 'planning');
  rejectsCode(() => service.control({ roomId, action: 'complete', taskVerification: { verified: true } }, OWNER), 'completion_not_ready');
  submit(service, roomId, clients.a.actor);
  assert.equal(service.read({ roomId }, OWNER).room.phase, 'implementation');
  submit(service, roomId, clients.i.actor, { artifacts: ['artifact:implementation'], verification: { tests: 'passed' } });
  const review = service.claim({ roomId }, clients.r.actor);
  assert.equal(review.context.currentTask.permission, 'read-only');
  assert.equal(review.context.currentTask.dependencies.length, 1);
  assert.equal(review.context.tasks[0].verification.confirmed, false);
  service.submit({ roomId, ...review, context: undefined, idempotencyKey: review.attemptId, body: 'Reviewed the implementation', verification: { passed: true } }, clients.r.actor);
  submit(service, roomId, clients.a.actor, { body: 'Completed synthesis with reported evidence' });
  const synthesis = service.read({ roomId }, OWNER);
  assert.equal(synthesis.room.status, 'waiting_input');
  assert.equal(synthesis.outcome.acceptance, 'pending');
  const accepted = service.control({ roomId, action: 'complete' }, OWNER);
  assert.equal(accepted.room.status, 'concluded');
  assert.equal(accepted.outcome.acceptance, 'human_accepted');
  assert.equal(accepted.outcome.verification.confirmed, false);
});

test('failed runtime result never advances implementation and required work cannot be skipped', t => {
  const { service } = fixture(t), roomId = create(service, { mode: 'collaboration', seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'grok' }, { id: 'r', name: 'Reviewer', role: 'reviewer', runtime: 'a2a' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r', 'a']) submit(service, roomId, clients[id].actor);
  const result = submit(service, roomId, clients.i.actor, { body: 'Runtime failed with authentication error', status: 'failed', actual: { model: 'actual-model' } });
  assert.equal(result.room.phase, 'implementation');
  assert.equal(result.room.status, 'waiting_input');
  assert.equal(result.tasks[0].status, 'failed');
  rejectsCode(() => service.control({ roomId, action: 'skip_turn', reason: 'skip failure' }, OWNER), 'required_work');
  rejectsCode(() => service.control({ roomId, action: 'advance_phase' }, OWNER), 'invalid_transition');
});

test('Fuli completion uses an authoritative async port and ignores supplied task verification', async t => {
  let verified = false, calls = 0;
  const { service } = fixture(t, { verifyCompletion: async ({ binding }) => { calls++; assert.equal(binding.coordinatedTaskId, 'task'); return { verified, taskStatus: 'completed', evidence: ['task-verification:1'] }; } });
  const roomId = create(service, { mode: 'collaboration', binding: { personalSpaceId: 'space', projectId: 'project', coordinatedTaskId: 'task' }, seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'codex' }, { id: 'r', name: 'Reviewer', role: 'reviewer', runtime: 'claude-code' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r', 'a', 'i', 'r', 'a']) submit(service, roomId, clients[id].actor);
  await assert.rejects(service.control({ roomId, action: 'complete', taskVerification: { verified: true } }, OWNER), error => error.code === 'task_verification_required');
  verified = true;
  const result = await service.control({ roomId, action: 'complete' }, OWNER);
  assert.equal(calls, 2);
  assert.equal(result.outcome.acceptance, 'task_verified');
  assert.equal(result.outcome.verification.confirmed, true);
});

test('two independent OS processes race one SQLite current-turn lease', async t => {
  const { service, databasePath } = fixture(t), roomId = create(service).room.id, clients = start(service, roomId);
  const script = `import {createRoundtableService} from ${JSON.stringify(new URL('../src/roundtables/service.js', import.meta.url).href)}; const s=createRoundtableService({databasePath:process.env.TEST_DB,clock:()=>10000}); const a=s.authenticate({roomId:process.env.TEST_ROOM,seatToken:process.env.TEST_TOKEN,sourceApplication:'mcp-client',sourceSessionId:'a-session'}); process.stdout.write('ready\\n'); process.stdin.once('data',()=>{process.stdout.write(JSON.stringify(s.claim({roomId:process.env.TEST_ROOM},a))+'\\n'); setTimeout(()=>{s.close();process.exit(0)},300)});`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TEST_DB: databasePath, TEST_ROOM: roomId, TEST_TOKEN: clients.a.invitation.seatToken }, stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) child.kill(); });
  const output = children.map(() => '');
  await Promise.all(children.map((child, index) => new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output[index] += chunk; if (output[index].includes('ready\n')) resolve(); });
    child.on('error', reject); child.on('exit', code => { if (!output[index].includes('ready\n')) reject(new Error(`Worker exited ${code}`)); });
  })));
  const completed = children.map(child => once(child, 'exit'));
  for (const child of children) child.stdin.write('claim\n');
  await Promise.all(completed);
  const claims = output.map(value => JSON.parse(value.trim().split('\n').at(-1)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(service.read({ roomId }, OWNER).room.stopReason, 'restart_interrupted');
});

test('owner can revoke concluded history access without changing its outcome or revision', t => {
  const { service } = fixture(t), roomId = create(service).room.id, clients = start(service, roomId);
  for (const id of ['a', 'b', 'a']) submit(service, roomId, clients[id].actor);
  const before = service.read({ roomId }, OWNER);
  service.revoke({ roomId, seatId: 'b' }, OWNER);
  rejectsCode(() => service.read({ roomId }, clients.b.actor), 'invite_invalid');
  assert.deepEqual(service.read({ roomId }, OWNER), before);
});

test('stopped late results are archived separately while terminal room history stays immutable', t => {
  const { service } = fixture(t), roomId = create(service).room.id, clients = start(service, roomId);
  const claim = service.claim({ roomId }, clients.a.actor);
  const stopped = service.control({ roomId, action: 'stop' }, OWNER);
  rejectsCode(() => service.submit({ roomId, ...claim, context: undefined, idempotencyKey: claim.attemptId, body: 'Late owned process result' }, clients.a.actor), 'stale_turn');
  const after = service.read({ roomId }, OWNER);
  assert.deepEqual(after.room, stopped.room);
  assert.deepEqual(after.messages, stopped.messages);
  assert.deepEqual(after.attempts, stopped.attempts);
  assert.equal(after.lateResults[0].body, 'Late owned process result');
  assert.equal(after.lateResults[0].status, 'stale');
});

test('private Agent context enters only successful own-seat claim and never shared persistence', async t => {
  let calls = 0;
  const { service, databasePath } = fixture(t, { contextProvider: async ({ seat, actor, binding }) => {
    calls++; assert.equal(seat.id, 'a'); assert.equal(actor.seatId, 'a'); assert.equal(binding.personalProjectId, 'project');
    return { knowledge: 'PRIVATE_CONTEXT_SENTINEL' };
  } });
  const roomId = create(service, { binding: { personalSpaceId: 'space', personalProjectId: 'project' }, seats: [{ ...seats()[0], agentId: 'agent-a', shareAgentContext: true }, seats()[1]] }).room.id;
  const clients = start(service, roomId);
  assert.equal(await service.claim({ roomId }, clients.b.actor), null);
  assert.equal(calls, 0);
  const claim = await service.claim({ roomId }, clients.a.actor);
  assert.equal(calls, 1);
  assert.equal(claim.context.privateAgentContext.knowledge, 'PRIVATE_CONTEXT_SENTINEL');
  assert.equal(JSON.stringify(service.read({ roomId }, clients.b.actor)).includes('PRIVATE_CONTEXT_SENTINEL'), false);
  assert.equal(readFileSync(databasePath + '-wal').includes(Buffer.from('PRIVATE_CONTEXT_SENTINEL')), false);
  assert.equal(await service.claim({ roomId }, clients.a.actor), null);
  assert.equal(calls, 1);
});

test('explicit owner task DAG orders seat bundles and cannot grant reviewer write access', t => {
  const { service } = fixture(t);
  const seatList = [seats()[0], { id: 'i2', name: 'Second', role: 'implementer', runtime: 'codex' }, { id: 'i1', name: 'First', role: 'implementer', runtime: 'codex' }, { id: 'r', name: 'Review', role: 'reviewer', runtime: 'mcp' }];
  const tasks = [{ id: 'first', title: 'First task', instructions: 'Inspect the contract', seatId: 'i1' }, { id: 'first-extra', title: 'Within same seat', seatId: 'i1', dependsOn: ['first'] }, { id: 'second', title: 'Second task', seatId: 'i2', dependsOn: ['first-extra'] }];
  const roomId = create(service, { mode: 'collaboration', seats: seatList, tasks }).room.id;
  const clients = start(service, roomId, ['a', 'i2', 'i1', 'r']);
  for (const id of ['a', 'i2', 'i1', 'r', 'a']) submit(service, roomId, clients[id].actor);
  assert.equal(service.read({ roomId }, OWNER).currentTurn.seatId, 'i1');
  const claim = service.claim({ roomId }, clients.i1.actor);
  assert.deepEqual(claim.context.currentTasks.map(task => task.id), ['first', 'first-extra']);
  assert.ok(claim.context.currentTasks.every(task => task.permission === 'read-only'));
  service.submit({ roomId, ...claim, context: undefined, idempotencyKey: claim.attemptId, body: 'Completed my task bundle', artifacts: ['artifact:task-bundle'] }, clients.i1.actor);
  const snapshot = service.read({ roomId }, OWNER);
  assert.equal(snapshot.currentTurn.seatId, 'i2');
  assert.ok(snapshot.tasks.filter(task => task.seatId === 'i1').every(task => task.status === 'reported_complete'));
  rejectsCode(() => create(service, { mode: 'collaboration', seats: seatList, tasks: [{ ...tasks[0], dependsOn: ['second'] }, { ...tasks[2], dependsOn: ['first'] }] }), 'task_cycle');
  rejectsCode(() => create(service, { mode: 'collaboration', seats: seatList, tasks: [{ id: 'outside', title: 'Unsafe', seatId: 'other' }] }), 'invalid_task_seat');
  rejectsCode(() => create(service, { seats: [seats()[0], { ...seats()[1], role: 'reviewer', execution: { permission: 'workspace-write', workspace: 'T:/workspace' } }] }), 'invalid_permission');
});

test('negative reported review verification blocks synthesis and remains unconfirmed', t => {
  const { service } = fixture(t), roomId = create(service, { mode: 'collaboration', seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'codex' }, { id: 'r', name: 'Review', role: 'reviewer', runtime: 'mcp' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r', 'a', 'i']) submit(service, roomId, clients[id].actor);
  const result = submit(service, roomId, clients.r.actor, { verification: { passed: false, findings: ['Contract bug'] } });
  assert.equal(result.room.phase, 'review');
  assert.equal(result.room.status, 'waiting_input');
  assert.equal(result.room.stopReason, 'review_failed');
  assert.equal(result.tasks.at(-1).status, 'failed');
  assert.equal(result.message.verification.confirmed, false);
  rejectsCode(() => service.control({ roomId, action: 'complete' }, OWNER), 'completion_not_ready');
});

test('revoked join history cannot start a room and replacement capability must join again', t => {
  const { service } = fixture(t), roomId = create(service).room.id;
  const first = participant(service, roomId, 'a'); participant(service, roomId, 'b');
  service.revoke({ roomId, seatId: 'a' }, OWNER);
  rejectsCode(() => service.control({ roomId, action: 'start' }, OWNER), 'seats_not_joined');
  const invitation = service.invite({ roomId, seatId: 'a' }, OWNER);
  const actor = service.authenticate({ roomId, seatToken: invitation.seatToken, sourceApplication: 'mcp-client', sourceSessionId: first.actor.sourceSessionId });
  rejectsCode(() => service.claim({ roomId }, actor), 'join_required');
  service.join({ roomId }, actor);
  const started = service.control({ roomId, action: 'start' }, OWNER);
  assert.equal(started.room.status, 'active');
  assert.equal('joinedInvitationId' in started.room.seats[0], false);
  assert.equal('joinedInvitationId' in service.claim({ roomId }, actor).context.seat, false);
});

test('standalone seat cannot assert Fuli identity and bound custom seat remains standalone', t => {
  const { service } = fixture(t);
  rejectsCode(() => create(service, { seats: [{ ...seats()[0], agentId: 'asserted-agent' }, seats()[1]] }), 'invalid_binding');
  const bound = create(service, { binding: { personalSpaceId: 'space', personalProjectId: 'project' } });
  assert.equal(bound.room.seats[0].identityKind, 'standalone');
});

test('completed implementation requires artifact evidence without consuming its claimed attempt', t => {
  const { service } = fixture(t), roomId = create(service, { mode: 'collaboration', seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'codex' }, { id: 'r', name: 'Review', role: 'reviewer', runtime: 'mcp' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r', 'a']) submit(service, roomId, clients[id].actor);
  const claim = service.claim({ roomId }, clients.i.actor), before = service.read({ roomId }, OWNER);
  const input = { roomId, ...claim, context: undefined, idempotencyKey: claim.attemptId, body: 'Implementation complete' };
  rejectsCode(() => service.submit(input, clients.i.actor), 'implementation_artifacts_required');
  assert.deepEqual(service.read({ roomId }, OWNER), before);
  const result = service.submit({ ...input, artifacts: ['artifact:completed-diff'] }, clients.i.actor);
  assert.equal(result.room.phase, 'review');
});

test('review prose or unknown verdict cannot pass; explicit false blocks and explicit true advances', t => {
  const { service } = fixture(t), roomId = create(service, { mode: 'collaboration', seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'codex' }, { id: 'r', name: 'Review', role: 'reviewer', runtime: 'mcp' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r', 'a', 'i']) submit(service, roomId, clients[id].actor);
  const claim = service.claim({ roomId }, clients.r.actor), before = service.read({ roomId }, OWNER);
  const input = { roomId, ...claim, context: undefined, idempotencyKey: claim.attemptId, body: 'Review failed: a correctness issue remains' };
  for (const verification of [undefined, 'passed', {}, { passed: 'true' }, { status: 'passed' }]) rejectsCode(() => service.submit({ ...input, verification }, clients.r.actor), 'review_verification_required');
  assert.deepEqual(service.read({ roomId }, OWNER), before);
  const failed = service.submit({ ...input, verification: { passed: false, findings: ['Correctness issue'] } }, clients.r.actor);
  assert.equal(failed.room.stopReason, 'review_failed');
  assert.equal(failed.room.phase, 'review');
  assert.equal(failed.room.status, 'waiting_input');
  service.control({ roomId, action: 'retry_turn' }, OWNER);
  const passed = submit(service, roomId, clients.r.actor, { verification: { passed: true }, body: 'Checked corrected evidence' });
  assert.equal(passed.room.phase, 'synthesis');
});

test('synthesis retains immutable earlier dissent even when moderator reports none', t => {
  const { service } = fixture(t), roomId = create(service).room.id, clients = start(service, roomId);
  const objection = submit(service, roomId, clients.a.actor, { kind: 'dissent', body: 'The proposal leaves the migration risk unresolved' }).message;
  submit(service, roomId, clients.b.actor);
  const final = submit(service, roomId, clients.a.actor, { dissent: [], body: 'Moderator reports consensus' });
  assert.deepEqual(final.outcome.dissent, [objection.body]);
  assert.equal(final.outcome.dissentReferences[0].messageId, objection.id);
  assert.equal(final.outcome.dissentReferences[0].seatId, 'a');
});

test('explicit dissent is bounded before any submission effect', t => {
  const { service } = fixture(t), roomId = create(service).room.id, clients = start(service, roomId);
  const claim = service.claim({ roomId }, clients.a.actor), before = service.read({ roomId }, OWNER);
  const input = { roomId, ...claim, context: undefined, idempotencyKey: claim.attemptId, body: 'Proposal' };
  for (const dissent of ['not-an-array', Array(21).fill('too many'), ['x'.repeat(2049)], [{ body: 'invalid type' }]]) rejectsCode(() => service.submit({ ...input, dissent }, clients.a.actor), 'invalid_dissent');
  assert.deepEqual(service.read({ roomId }, OWNER), before);
});

test('project-only completion records human acceptance and never claims a linked task quality gate', t => {
  let verificationCalls = 0;
  const { service } = fixture(t, { verifyCompletion: () => { verificationCalls++; return { verified: true, taskStatus: 'completed' }; } });
  const roomId = create(service, { mode: 'collaboration', binding: { personalSpaceId: 'space', personalProjectId: 'project', taskId: null }, seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'codex' }, { id: 'r', name: 'Review', role: 'reviewer', runtime: 'mcp' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r', 'a', 'i', 'r', 'a']) submit(service, roomId, clients[id].actor);
  const result = service.control({ roomId, action: 'complete' }, OWNER);
  assert.equal(verificationCalls, 0);
  assert.equal(result.outcome.acceptance, 'human_accepted');
  assert.equal(result.outcome.verification.confirmed, false);
});

test('explicit taskId completion cannot bypass a missing authoritative verification port', t => {
  const { service } = fixture(t);
  const roomId = create(service, { mode: 'collaboration', binding: { personalSpaceId: 'space', personalProjectId: 'project', taskId: 'linked-task' }, seats: [seats()[0], { id: 'i', name: 'Implementer', role: 'implementer', runtime: 'codex' }, { id: 'r', name: 'Review', role: 'reviewer', runtime: 'mcp' }] }).room.id;
  const clients = start(service, roomId, ['a', 'i', 'r']);
  for (const id of ['a', 'i', 'r', 'a', 'i', 'r', 'a']) submit(service, roomId, clients[id].actor);
  rejectsCode(() => service.control({ roomId, action: 'complete', taskVerification: { verified: true, taskStatus: 'completed' } }, OWNER), 'task_verification_required');
  const snapshot = service.read({ roomId }, OWNER);
  assert.equal(snapshot.room.status, 'waiting_input');
  assert.equal(snapshot.outcome.acceptance, 'pending');
  assert.equal(snapshot.outcome.verification.confirmed, false);
});
test('collaboration rejects missing mandatory implementation or independent review before persistence', () => {
  for (const role of ['specialist', 'implementer', 'reviewer']) {
    assert.throws(() => newRoom({ goal: 'Cannot finish without both delivery roles', mode: 'collaboration', seats: [
      { id: 'a', name: 'Moderator', role: 'moderator' }, { id: 'b', name: 'Participant', role }
    ] }, Date.now()), { code: 'missing_collaboration_role' });
  }
});
