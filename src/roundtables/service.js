import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRoundtableStore } from './store.js';
import { assertMutable, budgetReason, event, fail, finishTurn, newRoom, normalizeLimits, publicRoom, publicSeat, publicTurn, scheduleTurn, TERMINAL_STATUSES, text } from './domain.js';
import { DISCOVERY_INSTRUCTIONS, ROUNDTABLE_PROTOCOL, nextRoundtableAction, normalizeCapabilityQuery, normalizeSelfProfile, publicRoster } from './profiles.js';

const PROCESS_BOOT_ID = randomUUID();
const closedIssuers = new Set();
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const inputHash = value => hash(JSON.stringify(canonical(value)));
function boundedJson(value, name, max = 8192) {
  if (value === undefined || value === null) return null;
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > max) fail('invalid_input', `${name} exceeds its size bound`);
  return JSON.parse(serialized);
}
function artifacts(value = []) {
  if (!Array.isArray(value) || value.length > 20) fail('invalid_artifacts', 'At most 20 artifact references are allowed');
  return value.map(item => {
    if (typeof item === 'string') return text(item, 'artifact reference', 1024);
    if (!item || typeof item !== 'object') fail('invalid_artifacts', 'Artifact references need an ID');
    const result = { id: text(item.id, 'artifact.id', 1024) };
    for (const key of ['name', 'uri', 'mimeType', 'kind']) if (item[key] !== undefined) result[key] = text(item[key], `artifact.${key}`, 2048);
    return result;
  });
}
function explicitDissent(value = []) {
  if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || Buffer.byteLength(item, 'utf8') > 2048)) fail('invalid_dissent', 'Dissent must contain at most 20 nonempty strings of at most 2048 UTF-8 bytes each');
  const result = value.map(item => item.trim());
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8192) fail('invalid_dissent', 'Explicit dissent must fit within 8192 UTF-8 bytes');
  return result;
}
function processIsGone(attempt) {
  if (closedIssuers.has(attempt.issuer)) return true;
  if (attempt.processBootId === PROCESS_BOOT_ID) return false;
  try { process.kill(attempt.processId, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** Local owner and exact-seat capabilities enter through a trusted transport boundary. */
export function createRoundtableService({ databasePath = ':memory:', clock = Date.now, verifyCompletion, contextProvider } = {}) {
  const store = createRoundtableStore({ databasePath });
  const authenticated = new WeakMap();
  const issuer = randomUUID();
  const now = () => {
    const value = clock();
    const timestamp = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(timestamp)) fail('invalid_clock', 'Clock must return a timestamp');
    return timestamp;
  };
  const owner = actor => { if (actor?.kind !== 'owner') fail('owner_required', 'Only the local owner can perform this action', 403); };
  function authorize(room, actor, participantOnly = false) {
    if (actor?.kind === 'owner' && !participantOnly) return;
    const capability = actor && authenticated.get(actor);
    if (!capability || actor.kind !== 'participant' || actor.roomId !== room.id) fail('seat_forbidden', 'This capability does not authorize the roundtable', 403);
    const invitation = store.inviteById(capability.invitationId);
    if (!invitation || invitation.revoked_at !== null || invitation.expires_at <= now()) fail('invite_invalid', 'The invitation is expired or revoked', 401);
    if (invitation.room_id !== room.id || invitation.seat_id !== actor.seatId || !room.seats.some(s => s.id === actor.seatId)) fail('seat_forbidden', 'Seat is outside the invitation scope', 403);
  }
  function getRoom(id) {
    const room = store.getRoom(text(id, 'roomId', 128));
    if (!room) fail('room_not_found', 'Roundtable does not exist', 404);
    return room;
  }
  function snapshot(room, input = {}) {
    const after = input.afterSeq ?? input.after ?? input.cursor ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_cursor', 'Invalid message cursor or page limit');
    const messages = store.messages(room.id, after, limit);
    const attempts = [...room.turns, ...(room.currentTurn ? [room.currentTurn] : [])].flatMap(turn => turn.attempts.map(({ issuer: privateIssuer, processId, processBootId, invitationId, ...attempt }) => ({ turnId: turn.id, seatId: turn.seatId, ...attempt })));
    return { room: publicRoom(room), messages, currentTurn: publicTurn(room.currentTurn), tasks: structuredClone(room.tasks), outcome: structuredClone(room.outcome), events: structuredClone(room.events), attempts, lateResults: store.lateEvidence(room.id), nextCursor: messages.at(-1)?.seq ?? after, hasMore: room.nextSeq - 1 > (messages.at(-1)?.seq ?? after) };
  }
  function interrupt(room, reason, timestamp) {
    const turn = room.currentTurn;
    if (turn?.status === 'claimed') {
      const attempt = turn.attempts.at(-1);
      attempt.status = reason === 'turn_timeout' ? 'expired' : 'interrupted';
      attempt.finishedAt = timestamp;
      turn.status = 'interrupted';
      turn.fence += 1;
      event(room, 'attempt_interrupted', timestamp, { turnId: turn.id, attemptId: attempt.id, reason });
      for (const task of room.tasks.filter(t => turn.taskIds.includes(t.id))) task.status = 'interrupted';
    }
    room.status = 'paused'; room.stopReason = reason;
  }
  function refresh(room, timestamp) {
    if (TERMINAL_STATUSES.has(room.status)) return;
    const attempt = room.currentTurn?.attempts.at(-1);
    if (room.currentTurn?.status === 'claimed') {
      const invitation = store.inviteById(attempt.invitationId);
      if (!invitation || invitation.revoked_at !== null || invitation.expires_at <= timestamp) interrupt(room, 'invitation_expired_or_revoked', timestamp);
      else if (processIsGone(attempt)) interrupt(room, 'restart_interrupted', timestamp);
      else if (room.currentTurn.deadline <= timestamp) interrupt(room, 'turn_timeout', timestamp);
    }
    const reason = budgetReason(room, timestamp);
    if (reason && room.status === 'active') interrupt(room, reason, timestamp);
  }
  function transact(input, actor, work, { participantOnly = false, refreshState = true } = {}) {
    const result = store.transaction(() => {
      const room = getRoom(input.roomId);
      authorize(room, actor, participantOnly);
      const before = JSON.stringify(room), revision = room.revision, timestamp = now();
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision) fail('revision_conflict', 'Roundtable changed; read the current revision', 409);
      if (refreshState) refresh(room, timestamp);
      const result = work(room, timestamp);
      if (JSON.stringify(room) !== before) { room.updatedAt = timestamp; store.saveRoom(room, revision); }
      return typeof result === 'function' ? result() : result;
    });
    if (result?.deferredError) fail(result.deferredError.code, result.deferredError.message, result.deferredError.status);
    return result;
  }
  function requireJoined(room, actor) {
    const seat = room.seats.find(s => s.id === actor.seatId);
    if (seat.joinedAt === null || seat.joinedInvitationId !== authenticated.get(actor).invitationId || seat.sourceApplication !== actor.sourceApplication || seat.sourceSessionId !== actor.sourceSessionId) fail('join_required', 'Join with this invitation/application/session before claiming a turn', 409);
    return seat;
  }
  function assertSeatsReady(room, timestamp) {
    if (room.seats.some(seat => {
      const invitation = seat.joinedInvitationId && store.inviteById(seat.joinedInvitationId);
      return seat.joinedAt === null || !invitation || invitation.revoked_at !== null || invitation.expires_at <= timestamp;
    })) fail('seats_not_joined', 'Every seat must join with an active invitation after its runtime preflight', 409);
  }
  function defer(code, message, status = 409) { return { deferredError: { code, message, status } }; }
  function saveLate(room, input, timestamp) {
    const turn = [...room.turns, ...(room.currentTurn ? [room.currentTurn] : [])].find(t => t.id === input.turnId);
    const attempt = turn?.attempts.find(a => a.id === input.attemptId);
    if (attempt && !attempt.lateResult) {
      const evidence = { turnId: turn.id, attemptId: attempt.id, seatId: turn.seatId, receivedAt: timestamp, body: input.body, bodyHash: hash(input.body), artifacts: artifacts(input.artifacts), verification: boundedJson(input.verification ?? input.reportedVerification, 'verification'), status: 'stale' };
      store.recordLateEvidence(room.id, attempt.id, evidence);
      if (!TERMINAL_STATUSES.has(room.status)) {
        const { body, ...receipt } = evidence;
        attempt.lateResult = receipt;
        event(room, 'stale_result_received', timestamp, { turnId: turn.id, attemptId: attempt.id });
      }
    }
  }
  function complete(input, actor) {
    owner(actor);
    const initial = transact(input, actor, room => () => snapshot(room));
    const room = initial.room;
    if (room.mode !== 'collaboration' || room.phase !== 'synthesis' || room.status !== 'waiting_input' || initial.currentTurn) fail('completion_not_ready', 'Complete only after implementation, review and synthesis have finished', 409);
    const apply = confirmation => transact({ ...input, expectedRevision: room.revision }, actor, (current, timestamp) => {
      assertMutable(current);
      if (current.tasks.some(task => task.status !== 'reported_complete')) fail('tasks_incomplete', 'Every implementation and review task must report completion', 409);
      if ((room.binding?.taskId || room.binding?.coordinatedTaskId) && (confirmation?.verified !== true || confirmation.taskStatus !== 'completed')) fail('task_verification_required', 'The authoritative coordinated task has not verified completion', 409);
      current.status = 'concluded'; current.stopReason = null;
      const linkedTask = Boolean(room.binding?.taskId || room.binding?.coordinatedTaskId);
      current.outcome.acceptance = linkedTask ? 'task_verified' : 'human_accepted';
      current.outcome.acceptedAt = timestamp;
      current.outcome.verification.confirmed = linkedTask;
      if (linkedTask) current.outcome.verification.authoritativeEvidence = boundedJson(confirmation.evidence, 'completion evidence');
      event(current, 'owner_completed', timestamp, { acceptance: current.outcome.acceptance });
      return () => snapshot(current);
    });
    if (!room.binding?.taskId && !room.binding?.coordinatedTaskId) return apply(null);
    if (typeof verifyCompletion !== 'function') fail('task_verification_required', 'A Fuli task verification port is required', 409);
    const confirmation = verifyCompletion({ binding: room.binding, roomId: room.id });
    return confirmation && typeof confirmation.then === 'function' ? confirmation.then(apply) : apply(confirmation);
  }
  const service = {
    create(input, actor) {
      owner(actor);
      return store.transaction(() => {
        const key = input.idempotencyKey && text(input.idempotencyKey, 'idempotencyKey', 256), fingerprint = inputHash(input);
        const duplicate = store.getIdempotent('create', key, fingerprint);
        if (duplicate) return duplicate;
        const room = newRoom(input, now());
        store.insertRoom(room);
        const result = snapshot(room);
        if (key) store.saveIdempotent('create', key, fingerprint, result);
        return result;
      });
    },
    list(input = {}, actor) {
      if (actor?.kind !== 'owner') {
        const room = getRoom(actor?.roomId);
        authorize(room, actor);
        return { rooms: [publicRoom(room)] };
      }
      return { rooms: store.listRooms().filter(room => !input.status || room.status === input.status).slice(0, 100).map(publicRoom) };
    },
    read(input, actor) { return transact(input, actor, room => () => snapshot(room, input)); },
    invite(input, actor) {
      owner(actor);
      return transact(input, actor, (room, timestamp) => {
        assertMutable(room);
        const seatId = text(input.seatId, 'seatId', 128);
        if (!room.seats.some(s => s.id === seatId)) fail('seat_not_found', 'Seat does not exist', 404);
        const expiresInMs = input.expiresInMs ?? 3_600_000;
        if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1000 || expiresInMs > 86_400_000) fail('invalid_expiry', 'Invitation expiry must be between one second and one day');
        const seatToken = randomBytes(32).toString('base64url'), id = randomUUID(), expiresAt = timestamp + expiresInMs;
        store.insertInvite({ id, roomId: room.id, seatId, tokenHash: hash(seatToken), expiresAt });
        event(room, 'invitation_issued', timestamp, { seatId, expiresAt });
        return { invitationId: id, roomId: room.id, seatId, seatToken, expiresAt };
      });
    },
    revoke(input, actor) {
      owner(actor);
      return transact(input, actor, (room, timestamp) => {
        if (!input.invitationId && !input.seatId) fail('invalid_input', 'Provide invitationId or seatId');
        const revoked = store.revokeInvite(room.id, input.seatId ?? null, input.invitationId ?? null, timestamp);
        if (!TERMINAL_STATUSES.has(room.status)) event(room, 'invitation_revoked', timestamp, { seatId: input.seatId ?? null, revoked });
        if (room.currentTurn?.status === 'claimed') {
          const invitation = store.inviteById(room.currentTurn.attempts.at(-1).invitationId);
          if (invitation?.revoked_at !== null) interrupt(room, 'invitation_revoked', timestamp);
        }
        return () => ({ ...snapshot(room), revoked });
      });
    },
    authenticate(input) {
      const roomId = text(input.roomId, 'roomId', 128), seatToken = text(input.seatToken, 'seatToken', 256);
      const invitation = store.inviteByHash(hash(seatToken));
      if (!invitation || invitation.room_id !== roomId || invitation.revoked_at !== null || invitation.expires_at <= now()) fail('invite_invalid', 'The invitation is expired, revoked or outside this room', 401);
      const actor = Object.freeze({ kind: 'participant', roomId, seatId: invitation.seat_id, sourceApplication: text(input.sourceApplication, 'sourceApplication', 64), sourceSessionId: text(input.sourceSessionId, 'sourceSessionId', 256) });
      authenticated.set(actor, { invitationId: invitation.id });
      return actor;
    },
    join(input, actor) {
      return transact(input, actor, (room, timestamp) => {
        assertMutable(room);
        if (input.seatId && input.seatId !== actor.seatId) fail('seat_forbidden', 'Join only your authenticated seat', 403);
        const seat = room.seats.find(s => s.id === actor.seatId);
        if (room.currentTurn?.status === 'claimed' && room.currentTurn.seatId === seat.id && seat.sourceSessionId !== actor.sourceSessionId) fail('seat_busy', 'Seat has a current attempt in another session', 409);
        const selfProfile = input.selfProfile === undefined ? seat.selfProfile : normalizeSelfProfile(input.selfProfile);
        seat.joinedAt = timestamp; seat.joinedInvitationId = authenticated.get(actor).invitationId; seat.sourceApplication = actor.sourceApplication; seat.sourceSessionId = actor.sourceSessionId; seat.selfProfile = selfProfile;
        event(room, 'seat_joined', timestamp, { seatId: seat.id, sourceApplication: actor.sourceApplication, sourceSessionId: actor.sourceSessionId, identityVerified: false });
        return () => snapshot(room);
      }, { participantOnly: true });
    },
    discover(input, actor) {
      return transact(input, actor, (room) => {
        const seat = room.seats.find(candidate => candidate.id === actor.seatId);
        const capabilityQuery = normalizeCapabilityQuery(input.capabilityQuery ?? input.query);
        const roster = publicRoster(room.seats, capabilityQuery).map(publicSeat);
        const action = nextRoundtableAction(room, seat);
        const roomView = {
          id: room.id,
          goal: room.goal,
          mode: room.mode,
          status: room.status,
          phase: room.phase,
          round: room.round,
          stopReason: room.stopReason
        };
        return {
          protocol: ROUNDTABLE_PROTOCOL,
          protocolVersion: ROUNDTABLE_PROTOCOL.version,
          version: ROUNDTABLE_PROTOCOL.version,
          roomId: room.id,
          room: roomView,
          goal: room.goal,
          mode: room.mode,
          status: room.status,
          phase: room.phase,
          round: room.round,
          ownSeat: publicSeat(seat),
          roster,
          capabilityQuery,
          nextAction: action,
          instructions: DISCOVERY_INSTRUCTIONS
        };
      });
    },
    message(input, actor) {
      const body = text(input.body, 'body', 4096);
      const key = text(input.idempotencyKey, 'idempotencyKey', 256);
      return transact(input, actor, (room, timestamp) => {
        assertMutable(room);
        const sender = requireJoined(room, actor);
        const targetSeatId = text(input.toSeatId ?? input.targetSeatId, 'toSeatId', 128);
        const target = room.seats.find(seat => seat.id === targetSeatId);
        if (!target) fail('seat_not_found', 'Target seat does not exist in this roundtable', 404);
        const kind = input.kind ?? 'question';
        if (!['question', 'handoff'].includes(kind)) fail('invalid_kind', 'Peer messages must be a question or handoff');
        const replyTo = input.replyTo === undefined || input.replyTo === null ? null : text(input.replyTo, 'replyTo', 256);
        if (replyTo && !store.messageById(room.id, replyTo)) fail('message_not_found', 'replyTo must reference a message in this roundtable', 404);
        const fingerprint = inputHash({ roomId: room.id, targetSeatId, kind, body, replyTo });
        const scope = `peer-message:${room.id}:${sender.id}`;
        const duplicate = store.getIdempotent(scope, key, fingerprint);
        if (duplicate) return duplicate;
        const maxPeerMessages = room.limits.maxPeerMessages ?? 100;
        const peerMessageCount = room.peerMessageCount ?? 0;
        if (peerMessageCount >= maxPeerMessages) fail('peer_message_limit', 'Peer message budget is exhausted; required turns remain unaffected', 409);
        const message = {
          id: randomUUID(),
          seq: room.nextSeq++,
          seatId: sender.id,
          senderSeatId: sender.id,
          toSeatId: targetSeatId,
          targetSeatId,
          kind,
          body,
          replyTo,
          artifacts: [],
          verification: null,
          actual: null,
          status: 'peer',
          createdAt: timestamp,
          turnId: null,
          attemptId: null,
          sourceApplication: actor.sourceApplication,
          sourceSessionId: actor.sourceSessionId
        };
        store.appendMessage(room.id, message);
        room.peerMessageCount = peerMessageCount + 1;
        event(room, 'peer_message', timestamp, { messageId: message.id, senderSeatId: sender.id, toSeatId: targetSeatId, targetSeatId, kind });
        const result = { message, room: publicRoom(room), nextAction: nextRoundtableAction(room, sender) };
        store.saveIdempotent(scope, key, fingerprint, result);
        return result;
      }, { participantOnly: true });
    },
    claim(input, actor) {
      const result = transact(input, actor, (room, timestamp) => {
        assertMutable(room); const seat = requireJoined(room, actor);
        if (input.seatId && input.seatId !== actor.seatId) fail('seat_forbidden', 'Claim only your authenticated seat', 403);
        if (room.status !== 'active') return null;
        const turn = room.currentTurn;
        if (!turn || turn.seatId !== seat.id) return null;
        if (turn.status !== 'pending') return null;
        if (turn.attempts.length >= 2) { interrupt(room, 'retry_limit', timestamp); return null; }
        const attemptId = randomUUID(), deadline = Math.min(timestamp + room.limits.turnTimeoutMs, room.startedAt + room.limits.maxDurationMs);
        turn.status = 'claimed'; turn.attemptId = attemptId; turn.fence += 1; turn.deadline = deadline;
        turn.attempts.push({ id: attemptId, fence: turn.fence, status: 'running', startedAt: timestamp, finishedAt: null, sourceApplication: actor.sourceApplication, sourceSessionId: actor.sourceSessionId, issuer, processId: process.pid, processBootId: PROCESS_BOOT_ID, invitationId: authenticated.get(actor).invitationId });
        const tasks = room.tasks.filter(t => turn.taskIds.includes(t.id)), task = tasks[0];
        for (const assigned of tasks) assigned.status = 'running';
        event(room, 'turn_claimed', timestamp, { turnId: turn.id, seatId: seat.id, attemptId });
        const messages = store.recentMessages(room.id, 12);
        return { turnId: turn.id, attemptId, fence: turn.fence, deadline, context: { roomId: room.id, goal: room.goal, mode: room.mode, phase: room.phase, round: room.round, scope: room.scope, seat: publicSeat(seat), roster: room.seats.map(publicSeat), messages, tasks: structuredClone(room.tasks), currentTask: structuredClone(task ?? null), currentTasks: structuredClone(tasks), truncated: room.nextSeq - 1 > messages.length, earlierMessagesAvailable: room.nextSeq - 1 > messages.length } };
      }, { participantOnly: true });
      if (!result || !contextProvider || result.context.scope.kind !== 'fuli' || !result.context.seat.shareAgentContext) return result;
      const addContext = context => {
        if (!context || context.status === 'client_not_allowed') { result.context.privateContextUnavailable = context?.guidance ?? 'private_context_not_available'; return result; }
        result.context.privateAgentContext = boundedJson(context, 'private Agent context', 131_072); return result;
      };
      const unavailable = () => { result.context.privateContextUnavailable = 'context_provider_unavailable'; return result; };
      try {
        const context = contextProvider({ binding: getRoom(input.roomId).binding, seat: result.context.seat, actor });
        return context && typeof context.then === 'function' ? context.then(addContext).catch(unavailable) : addContext(context);
      } catch { return unavailable(); }
    },
    submit(input, actor) {
      text(input.body, 'body');
      const key = text(input.idempotencyKey, 'idempotencyKey', 256);
      return transact(input, actor, (room, timestamp) => {
        const fingerprint = inputHash(input), scope = `submit:${room.id}:${actor.seatId}`;
        const duplicate = store.getIdempotent(scope, key, fingerprint);
        if (duplicate) return duplicate;
        const turn = room.currentTurn;
        if (!turn || turn.seatId !== actor.seatId || turn.id !== input.turnId) {
          const historical = [...room.turns, ...(turn ? [turn] : [])].find(t => t.id === input.turnId);
          if (historical && historical.seatId !== actor.seatId) fail('seat_forbidden', 'Submit only your own turn', 403);
          saveLate(room, input, timestamp);
          return defer('stale_turn', 'This turn is no longer current');
        }
        requireJoined(room, actor);
        if (turn.status !== 'claimed' || turn.attemptId !== input.attemptId || turn.fence !== input.fence || turn.deadline <= timestamp || TERMINAL_STATUSES.has(room.status)) {
          saveLate(room, input, timestamp);
          return defer('stale_fence', 'This attempt expired or its fence is stale');
        }
        if (!['active', 'paused'].includes(room.status)) return defer('room_not_active', 'This room cannot accept the attempt');
        const reported = boundedJson(input.verification ?? input.reportedVerification, 'verification');
        const resultStatus = input.status ?? input.outcomeStatus ?? 'completed';
        if (!['completed', 'failed', 'blocked', 'cancelled'].includes(resultStatus)) fail('invalid_status', 'Unknown result status');
        const artifactReferences = artifacts(input.artifacts), declaredDissent = explicitDissent(input.dissent);
        if (resultStatus === 'completed' && room.phase === 'implementation' && !artifactReferences.length) fail('implementation_artifacts_required', 'Completed implementation must include at least one artifact reference; add artifacts and resubmit this same attempt');
        if (resultStatus === 'completed' && room.phase === 'review' && typeof reported?.passed !== 'boolean') fail('review_verification_required', 'Completed review must include verification.passed as true or false; provide the explicit verdict and resubmit this same attempt');
        const kind = input.kind ?? ({ discussion: 'proposal', planning: 'proposal', implementation: 'result', review: 'review', synthesis: 'result' }[room.phase]);
        if (!['proposal', 'question', 'review', 'handoff', 'result', 'dissent'].includes(kind)) fail('invalid_kind', 'Unknown participant message kind');
        const actual = input.actual ? { sourceApplication: actor.sourceApplication,
          reportedApplication: input.actual.sourceApplication ? text(input.actual.sourceApplication, 'actual.sourceApplication', 64) : null,
          applicationLabel: input.actual.applicationLabel ? text(input.actual.applicationLabel, 'actual.applicationLabel', 128) : null,
          provider: input.actual.provider ? text(input.actual.provider, 'actual.provider', 128) : null,
          model: input.actual.model ? text(input.actual.model, 'actual.model', 256) : null,
          sessionId: input.actual.sessionId ? text(input.actual.sessionId, 'actual.sessionId', 256) : null,
          remoteTaskId: input.actual.remoteTaskId ? text(input.actual.remoteTaskId, 'actual.remoteTaskId', 256) : null,
          evidence: boundedJson(input.actual.evidence ?? input.actual.evidenceLevel, 'actual.evidence', 2048),
          cancellationConfirmed: typeof input.actual.cancellationConfirmed === 'boolean' ? input.actual.cancellationConfirmed : null,
          usage: boundedJson(input.actual.usage, 'actual.usage', 2048), provenance: 'participant_reported', identityVerified: false } : null;
        const message = { id: randomUUID(), seq: room.nextSeq++, seatId: actor.seatId, kind, body: text(input.body, 'body'), artifacts: artifactReferences, dissent: declaredDissent, verification: { reported, confirmed: false }, actual, status: resultStatus, createdAt: timestamp, turnId: turn.id, attemptId: input.attemptId, sourceApplication: actor.sourceApplication, sourceSessionId: actor.sourceSessionId };
        store.appendMessage(room.id, message); room.agentMessageCount += 1;
        const attempt = turn.attempts.at(-1); attempt.status = resultStatus; attempt.finishedAt = timestamp; attempt.messageId = message.id; attempt.actual = actual;
        turn.status = resultStatus;
        const failedReview = room.phase === 'review' && (reported?.passed === false || reported?.status === 'failed');
        const failedResult = resultStatus !== 'completed' || failedReview;
        for (const task of room.tasks.filter(t => turn.taskIds.includes(t.id))) { task.status = failedResult ? resultStatus === 'blocked' ? 'blocked' : 'failed' : 'reported_complete'; task.artifacts = message.artifacts; task.verification = message.verification; }
        if (failedResult) {
          const waiting = resultStatus === 'blocked' && ['waiting_auth', 'waiting_input'].includes(input.blockedReason) ? input.blockedReason : null;
          room.status = waiting ?? 'waiting_input'; room.stopReason = failedReview ? 'review_failed' : waiting ?? `participant_${resultStatus}`;
          event(room, 'attempt_failed', timestamp, { turnId: turn.id, reason: room.stopReason });
        }
        else {
          if (room.phase === 'synthesis') {
            // Earlier objections are immutable public evidence, not editable moderator input.
            const objections = store.recentMessages(room.id, room.nextSeq - 1).filter(prior => prior.kind === 'dissent' || prior.dissent?.length);
            const retainedDissent = objections.flatMap(prior => [...(prior.kind === 'dissent' ? [prior.body] : []), ...(prior.dissent ?? [])]);
            room.outcome = { body: message.body, dissent: [...new Set([...retainedDissent, ...declaredDissent])], dissentReferences: objections.map(prior => ({ messageId: prior.id, seatId: prior.seatId, seq: prior.seq })), artifacts: [...room.tasks.flatMap(t => t.artifacts), ...message.artifacts], verification: message.verification, acceptance: 'pending', createdAt: timestamp };
          }
          finishTurn(room, timestamp);
          const reason = budgetReason(room, timestamp); if (reason && room.status === 'active') interrupt(room, reason, timestamp);
        }
        return () => {
          const result = { message, room: publicRoom(room), currentTurn: publicTurn(room.currentTurn), outcome: structuredClone(room.outcome), tasks: structuredClone(room.tasks) };
          store.saveIdempotent(scope, key, fingerprint, result); return result;
        };
      }, { participantOnly: true });
    },
    control(input, actor) {
      owner(actor);
      if (input.action === 'complete') return complete(input, actor);
      return transact(input, actor, (room, timestamp) => {
        assertMutable(room);
        switch (input.action) {
          case 'start':
            if (room.status !== 'draft') fail('invalid_transition', 'Start only a draft roundtable', 409);
            assertSeatsReady(room, timestamp);
            room.status = 'active'; room.startedAt = timestamp; room.stopReason = null; scheduleTurn(room, timestamp); break;
          case 'pause':
            if (room.status !== 'active') fail('invalid_transition', 'Pause only an active roundtable', 409);
            room.status = 'paused'; room.stopReason = 'owner_paused'; break;
          case 'resume': {
            if (!['paused', 'waiting_input', 'waiting_auth'].includes(room.status)) fail('invalid_transition', 'Resume only a paused or waiting roundtable', 409);
            const reason = budgetReason(room, timestamp); if (reason) fail('budget_exhausted', `Cannot resume: ${reason}`, 409);
            assertSeatsReady(room, timestamp);
            if (room.currentTurn && !['pending', 'claimed'].includes(room.currentTurn.status)) fail('retry_required', 'Explicit retry or skip is required for interrupted/failed work', 409);
            if (room.phase === 'synthesis' && !room.currentTurn && room.outcome) fail('completion_required', 'Owner completion is required after synthesis', 409);
            room.status = 'active'; room.stopReason = null; scheduleTurn(room, timestamp); break;
          }
          case 'stop':
            if (room.currentTurn) {
              const turn = room.currentTurn, attempt = turn.attempts.at(-1);
              if (attempt?.status === 'running') { attempt.status = 'cancellation_requested'; attempt.finishedAt = timestamp; }
              turn.status = 'cancelled'; turn.fence += 1; room.turns.push(turn); room.currentTurn = null;
            }
            room.status = 'cancelled'; room.stopReason = 'owner_stopped'; event(room, 'cancellation_requested', timestamp, { confirmed: false }); break;
          case 'retry_turn': {
            if (!['paused', 'waiting_input', 'waiting_auth'].includes(room.status) || !room.currentTurn || ['pending', 'claimed'].includes(room.currentTurn.status)) fail('invalid_transition', 'Retry only interrupted or failed work', 409);
            if (room.currentTurn.attempts.length >= 2) fail('retry_limit', 'A turn permits at most one explicit retry', 409);
            const reason = budgetReason(room, timestamp); if (reason) fail('budget_exhausted', `Cannot retry: ${reason}`, 409);
            room.currentTurn.status = 'pending'; room.currentTurn.attemptId = null; room.currentTurn.deadline = null; room.currentTurn.fence += 1;
            room.status = 'active'; room.stopReason = null; break;
          }
          case 'skip_turn':
            if (!room.currentTurn || room.currentTurn.status === 'claimed') fail('invalid_transition', 'A running turn must finish or expire before it can be skipped', 409);
            text(input.reason, 'skip reason', 2048);
            if (['implementation', 'review', 'synthesis'].includes(room.phase)) fail('required_work', 'Required implementation, review and synthesis cannot be skipped', 409);
            event(room, 'turn_skipped', timestamp, { turnId: room.currentTurn.id, reason: input.reason }); room.currentTurn.status = 'skipped'; finishTurn(room, timestamp); break;
          case 'advance_phase':
            if (room.phase !== 'discussion' || room.currentTurn?.status === 'claimed' || room.phaseIndex !== 0 || room.round === 1) fail('invalid_transition', 'Advance after a complete discussion round and before the next claim', 409);
            if (room.currentTurn) { room.currentTurn.status = 'cancelled'; room.turns.push(room.currentTurn); room.currentTurn = null; }
            room.phase = room.mode === 'discussion' ? 'synthesis' : 'planning'; room.phaseIndex = 0; scheduleTurn(room, timestamp); break;
          case 'next_round':
            if (room.phase !== 'discussion' || !room.currentTurn || room.currentTurn.status !== 'pending' || room.phaseIndex !== 0) fail('invalid_transition', 'Discussion rounds advance automatically after each seat has a turn', 409);
            break;
          case 'update_limits':
            room.limits = normalizeLimits({ ...room.limits, ...input.limits }); break;
          default: fail('invalid_action', 'Unknown roundtable action');
        }
        event(room, 'owner_control', timestamp, { action: input.action });
        return () => snapshot(room);
      });
    },
    addHumanMessage(input, actor) {
      owner(actor);
      return transact(input, actor, (room, timestamp) => {
        assertMutable(room);
        const key = input.idempotencyKey && text(input.idempotencyKey, 'idempotencyKey', 256), fingerprint = inputHash(input), scope = `human:${room.id}`;
        const duplicate = store.getIdempotent(scope, key, fingerprint); if (duplicate) return duplicate;
        const message = { id: randomUUID(), seq: room.nextSeq++, seatId: null, kind: 'human', body: text(input.body, 'body'), artifacts: artifacts(input.artifacts), verification: null, actual: null, status: 'input', createdAt: timestamp, turnId: null, attemptId: null, sourceApplication: 'local-owner', sourceSessionId: null };
        store.appendMessage(room.id, message);
        return () => { const result = { ...snapshot(room), message }; if (key) store.saveIdempotent(scope, key, fingerprint, result); return result; };
      });
    },
    close() { closedIssuers.add(issuer); store.close(); }
  };
  return service;
}
