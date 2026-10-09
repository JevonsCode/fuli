import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';

export const DEFAULT_LIMITS = Object.freeze({ maxRounds: 3, maxMessages: 30, maxDurationMs: 1_800_000, turnTimeoutMs: 300_000 });
export const TERMINAL_STATUSES = new Set(['concluded', 'failed', 'cancelled']);
const ROLES = new Set(['moderator', 'specialist', 'implementer', 'reviewer']);
const RUNTIMES = new Set(['mcp', 'codex', 'claude-code', 'pi', 'grok', 'a2a']);
const PHASES = ['discussion', 'planning', 'implementation', 'review', 'synthesis'];

export class RoundtableError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'RoundtableError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

export function fail(code, message, status = 400) { throw new RoundtableError(code, message, status); }

export function text(value, name, max = 16_384) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max) fail('invalid_input', `${name} must be nonempty and at most ${max} UTF-8 bytes`);
  return value.trim();
}

export function normalizeLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, maximum] of Object.entries(DEFAULT_LIMITS)) {
    const value = input[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('invalid_limits', `${key} must be between 1 and ${maximum}`);
    limits[key] = value;
  }
  limits.turnTimeoutMs = Math.min(limits.turnTimeoutMs, limits.maxDurationMs);
  return limits;
}

export function newRoom(input, now) {
  if (!['discussion', 'collaboration'].includes(input.mode ?? 'discussion')) fail('invalid_mode', 'Unknown roundtable mode');
  if (!Array.isArray(input.seats) || input.seats.length < 2 || input.seats.length > 6) fail('invalid_seats', 'Choose between two and six seats');
  const seats = input.seats.map(raw => {
    const id = text(raw.id ?? randomUUID(), 'seat.id', 128);
    if (!input.binding && (raw.agentId || raw.shareAgentContext === true)) fail('invalid_binding', 'Standalone seats cannot claim a Fuli Agent identity or private context');
    if (!ROLES.has(raw.role)) fail('invalid_role', 'Unknown seat role');
    if (!RUNTIMES.has(raw.runtime ?? 'mcp')) fail('invalid_runtime', 'Unknown participant runtime');
    const execution = { permission: 'read-only', workspace: null };
    if (raw.execution?.permission === 'workspace-write') {
      if (raw.role !== 'implementer') fail('invalid_permission', 'Only implementer seats can receive workspace write permission');
      execution.permission = 'workspace-write';
      execution.workspace = text(raw.execution.workspace, 'execution.workspace', 4096);
      if (!posix.isAbsolute(execution.workspace) && !win32.isAbsolute(execution.workspace)) fail('invalid_workspace', 'Write permission requires an explicit absolute workspace');
    } else if (raw.execution?.permission && raw.execution.permission !== 'read-only') fail('invalid_permission', 'Unknown execution permission');
    return { id, name: text(raw.name, 'seat.name', 256), role: raw.role, runtime: raw.runtime ?? 'mcp', agentId: raw.agentId ? text(raw.agentId, 'seat.agentId', 256) : null, shareAgentContext: raw.shareAgentContext === true, identityKind: input.binding && raw.agentId ? 'fuli' : 'standalone', execution, joinedAt: null, joinedInvitationId: null, sourceApplication: null, sourceSessionId: null };
  });
  if (new Set(seats.map(s => s.id)).size !== seats.length) fail('duplicate_seat', 'Seat IDs must be distinct');
  if (seats.filter(s => s.role === 'moderator').length !== 1) fail('invalid_moderator', 'Exactly one moderator is required');
  if (input.mode === 'collaboration' && (!seats.some(seat => seat.role === 'implementer') || !seats.some(seat => seat.role === 'reviewer'))) {
    fail('missing_collaboration_role', 'Collaboration requires an implementer and an independent reviewer');
  }
  const id = randomUUID();
  let binding = null;
  if (input.binding) {
    binding = { personalSpaceId: text(input.binding.personalSpaceId, 'binding.personalSpaceId', 256) };
    const projectKey = input.binding.personalProjectId ? 'personalProjectId' : 'projectId';
    binding[projectKey] = text(input.binding[projectKey], `binding.${projectKey}`, 256);
    for (const key of ['taskId', 'coordinatedTaskId', 'artifactRevision']) if (input.binding[key] !== undefined && input.binding[key] !== null) binding[key] = text(input.binding[key], `binding.${key}`, 256);
  }
  const implementers = seats.filter(s => s.role === 'implementer');
  const tasks = input.mode === 'collaboration' ? implementationTasks(input.tasks, implementers, id, input.goal) : [];
  if (input.mode === 'collaboration') {
    for (const seat of seats.filter(s => s.role === 'reviewer')) tasks.push({ id: `${id}:review:${seat.id}`, title: 'Review implementation / 审查实施', instructions: input.goal, seatId: seat.id, phase: 'review', status: 'pending', dependencies: tasks.filter(t => t.phase === 'implementation').map(t => t.id), permission: 'read-only', workspace: null, artifacts: [], verification: null });
  }
  return { id, goal: text(input.goal, 'goal'), mode: input.mode ?? 'discussion', binding, scope: binding ? { kind: 'fuli', ...binding } : { kind: 'temporary', id: `temporary:${id}`, label: 'Temporary collaboration / 临时协作', identityAuthority: 'standalone' }, seats, limits: normalizeLimits(input.limits), status: 'draft', phase: 'discussion', revision: 0, round: 1, phaseIndex: 0, agentMessageCount: 0, nextSeq: 1, nextTurnNumber: 1, createdAt: now, updatedAt: now, startedAt: null, stopReason: null, currentTurn: null, turns: [], tasks, outcome: null, events: [] };
}

function implementationTasks(input, implementers, roomId, goal) {
  if (input !== undefined && (!Array.isArray(input) || !input.length || input.length > 24)) fail('invalid_tasks', 'Provide between one and 24 tasks');
  const supplied = input ?? implementers.map((seat, index) => ({ id: `${roomId}:implementation:${seat.id}`, title: `Implement: ${seat.name}`, seatId: seat.id, instructions: goal, dependsOn: index ? [`${roomId}:implementation:${implementers[index - 1].id}`] : [] }));
  const tasks = supplied.map(raw => {
    const seat = implementers.find(s => s.id === raw.seatId);
    if (!seat) fail('invalid_task_seat', 'Tasks can only be assigned to this room\'s implementer seats');
    const dependencies = raw.dependsOn ?? [];
    if (!Array.isArray(dependencies) || dependencies.length > 24) fail('invalid_dependencies', 'Task dependencies must be a bounded list');
    return { id: text(raw.id ?? randomUUID(), 'task.id', 256), title: text(raw.title, 'task.title', 512), instructions: text(raw.instructions ?? goal, 'task.instructions', 8192), seatId: seat.id, phase: 'implementation', status: 'pending', dependencies: dependencies.map(dep => text(dep, 'task dependency', 256)), permission: seat.execution.permission, workspace: seat.execution.workspace, artifacts: [], verification: null };
  });
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) fail('duplicate_task', 'Task IDs must be distinct');
  const byId = new Map(tasks.map(task => [task.id, task])), visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) fail('task_cycle', 'Task dependencies must be acyclic');
    if (visited.has(id)) return;
    const task = byId.get(id); if (!task) fail('invalid_dependencies', 'Dependencies must refer to tasks in this room');
    visiting.add(id); for (const dependency of task.dependencies) visit(dependency); visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  if (input) for (const seat of implementers) if (!tasks.some(t => t.seatId === seat.id)) fail('unassigned_implementer', 'Every implementer needs an assigned task');
  // A seat reports one bundle per turn; bundle dependencies must also be acyclic.
  orderedImplementers(implementers, tasks);
  return tasks;
}

function orderedImplementers(seats, tasks) {
  const pending = [...seats], result = [], byId = new Map(tasks.map(t => [t.id, t]));
  while (pending.length) {
    const index = pending.findIndex(seat => tasks.filter(t => t.seatId === seat.id).every(task => task.dependencies.every(id => byId.get(id).seatId === seat.id || result.some(done => done.id === byId.get(id).seatId))));
    if (index < 0) fail('task_bundle_cycle', 'Dependencies between seat task bundles must be acyclic');
    result.push(pending.splice(index, 1)[0]);
  }
  return result;
}

export function assertMutable(room) {
  if (TERMINAL_STATUSES.has(room.status)) fail('terminal_room', 'Terminal roundtables are immutable', 409);
}

export function event(room, kind, now, details = {}) {
  room.events.push({ id: randomUUID(), kind, createdAt: now, ...details });
  // Events are operational metadata; the immutable message and attempt history is retained.
  if (room.events.length > 500) room.events.shift();
}

export function phaseSeats(room) {
  if (room.phase === 'discussion') return room.seats;
  if (room.phase === 'planning' || room.phase === 'synthesis') return room.seats.filter(s => s.role === 'moderator');
  const seats = room.seats.filter(s => s.role === (room.phase === 'implementation' ? 'implementer' : 'reviewer'));
  return room.phase === 'implementation' ? orderedImplementers(seats, room.tasks.filter(t => t.phase === 'implementation')) : seats;
}

export function scheduleTurn(room, now) {
  if (room.status !== 'active' || room.currentTurn) return;
  const seat = phaseSeats(room)[room.phaseIndex];
  if (!seat) {
    room.status = 'waiting_input';
    room.stopReason = `missing_${room.phase}_seat`;
    event(room, 'phase_blocked', now, { reason: room.stopReason });
    return;
  }
  const tasks = room.tasks.filter(t => t.phase === room.phase && t.seatId === seat.id), task = tasks[0];
  if (tasks.some(assigned => assigned.dependencies.some(id => { const dependency = room.tasks.find(t => t.id === id); return dependency?.seatId !== seat.id && dependency?.status !== 'reported_complete'; }))) {
    room.status = 'waiting_input'; room.stopReason = 'task_dependencies_incomplete'; return;
  }
  room.currentTurn = { id: `${room.id}:turn:${room.nextTurnNumber++}`, seatId: seat.id, phase: room.phase, round: room.round, status: 'pending', fence: 0, attemptId: null, deadline: null, taskId: task?.id ?? null, taskIds: tasks.map(t => t.id), attempts: [] };
}

export function finishTurn(room, now) {
  const turn = room.currentTurn;
  room.turns.push(turn);
  room.currentTurn = null;
  room.phaseIndex += 1;
  if (room.phaseIndex < phaseSeats(room).length) { scheduleTurn(room, now); return; }
  room.phaseIndex = 0;
  if (room.phase === 'discussion' && room.round < room.limits.maxRounds) { room.round += 1; scheduleTurn(room, now); return; }
  if (room.phase === 'synthesis') {
    room.status = room.mode === 'discussion' ? 'concluded' : 'waiting_input';
    room.stopReason = room.mode === 'discussion' ? null : 'owner_completion_required';
    if (room.outcome) room.outcome.acceptance = 'pending';
    event(room, 'synthesis_complete', now, { status: room.status });
    return;
  }
  room.phase = room.mode === 'discussion' ? 'synthesis' : PHASES[PHASES.indexOf(room.phase) + 1];
  event(room, 'phase_changed', now, { phase: room.phase });
  scheduleTurn(room, now);
}

export function budgetReason(room, now) {
  if (room.startedAt !== null && now - room.startedAt >= room.limits.maxDurationMs) return 'duration_limit';
  if (room.agentMessageCount >= room.limits.maxMessages) return 'message_limit';
  return null;
}

export function publicRoom(room) {
  const { nextSeq, nextTurnNumber, phaseIndex, currentTurn, turns, tasks, outcome, events, ...result } = room;
  return structuredClone({ ...result, phaseIndex, seats: room.seats.map(publicSeat) });
}

export function publicSeat(seat) { const { joinedInvitationId, ...result } = seat; return structuredClone(result); }

export function publicTurn(turn) {
  if (!turn) return null;
  const { attempts, ...result } = turn;
  return structuredClone(result);
}
