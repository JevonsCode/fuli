import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../app/application-error.js';
import { positiveInteger, requiredString, uniqueTextArray } from '../validation/values.js';
import { TaskScheduleStore } from './store.js';

const UNIT_MS = Object.freeze({ minutes: 60_000, hours: 3_600_000, days: 86_400_000 });
const MINIMUM_INTERVAL_MS = 15 * 60_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_FAILURE_THRESHOLD = 3;
const SCHEDULE_FIELDS = ['title', 'objective', 'workKind', 'requiredCapabilities', 'leadAgentId', 'every', 'startMode', 'failureThreshold'];
const conflict = () => new ApplicationError('task_schedule_conflict', 'This schedule changed. Reload and try again.', { status: 409 });
const missing = () => new ApplicationError('task_schedule_not_found', 'Task schedule not found.', { status: 404 });

// Scheduled project Agent tasks with a circuit breaker. Each due slot creates
// one task through the normal routing path (idempotent per slot). A slot is
// skipped while the previous scheduled task is still open, and the schedule
// pauses itself after failureThreshold consecutive failed tasks; resuming is a
// deliberate act that also resets the breaker.
export function createTaskScheduleService({ app, openStore = () => new TaskScheduleStore(), now = () => new Date() }) {
  let store = null;
  const db = () => (store ??= openStore());
  const iso = () => now().toISOString();
  const owned = (input) => {
    const schedule = db().get(requiredString(input.scheduleId, 'scheduleId', 128));
    if (!schedule || schedule.personalSpaceId !== app.config.personal.spaceId) throw missing();
    return schedule;
  };

  async function create(input) {
    const body = scheduleBody(input);
    const space = requiredString(input.personalSpaceId, 'personalSpaceId', 128);
    if (space !== app.config.personal.spaceId) throw missing();
    const firstRunAt = input.firstRunAt ? new Date(input.firstRunAt) : new Date(now().getTime() + intervalMs(body.every));
    if (Number.isNaN(firstRunAt.getTime())) throw new TypeError('firstRunAt must be an ISO date-time');
    return db().insert({ id: randomUUID(), space, project: requiredString(input.personalProjectId, 'personalProjectId', 128),
      enabled: true, body, nextRunAt: firstRunAt.toISOString(), at: iso() });
  }

  function update(input) {
    const schedule = owned(input);
    const changes = Object.fromEntries(SCHEDULE_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    const body = scheduleBody({ ...schedule.body, ...changes });
    return db().update(schedule.id, input.expectedRevision, { body }, iso()) ?? (() => { throw conflict(); })();
  }

  function setEnabled(input, enabled) {
    const schedule = owned(input);
    // Resuming closes the breaker (failures before it no longer count) and starts
    // from the next interval, never a backlog of missed slots.
    const changes = enabled
      ? { enabled: true, pausedReason: null, breakerResetAt: iso(),
        nextRunAt: new Date(now().getTime() + intervalMs(schedule.body.every)).toISOString() }
      : { enabled: false, pausedReason: 'paused_by_user' };
    return db().update(schedule.id, input.expectedRevision, changes, iso()) ?? (() => { throw conflict(); })();
  }

  function list(input) {
    const space = requiredString(input.personalSpaceId, 'personalSpaceId', 128);
    if (space !== app.config.personal.spaceId) return { schedules: [] };
    return { schedules: db().list(space, input.personalProjectId ?? null)
      .map(schedule => ({ ...schedule, recentRuns: db().runs(schedule.id, 5) })) };
  }

  async function refreshRuns(schedule, limit) {
    const runs = db().runs(schedule.id, limit);
    for (const run of runs) {
      if (!run.taskId || TERMINAL.has(run.status)) continue;
      try {
        const task = await app.viewProjectAgentTask({ personalSpaceId: schedule.personalSpaceId,
          personalProjectId: schedule.personalProjectId, taskId: run.taskId, includeEvents: false });
        if (task?.status && task.status !== run.status) {
          db().finishRun(schedule.id, run.slot, run.taskId, task.status);
          run.status = task.status;
        }
      } catch { /* An unreadable task keeps its last known status; the breaker never guesses a failure. */ }
    }
    return runs;
  }

  async function runSchedule(schedule) {
    const threshold = schedule.body.failureThreshold;
    const runs = await refreshRuns(schedule, Math.max(threshold, 1));
    const nextRunAt = followingSlot(schedule.nextRunAt, schedule.body.every, now());
    const advance = (pausedReason = undefined, enabled = undefined) =>
      db().update(schedule.id, schedule.revision, { nextRunAt, pausedReason, enabled }, iso());
    let failures = 0;
    for (const run of runs) {
      if (run.status !== 'failed' || (schedule.breakerResetAt && run.createdAt <= schedule.breakerResetAt)) break;
      failures += 1;
    }
    if (failures >= threshold) {
      advance('circuit_open', false);
      return { scheduleId: schedule.id, outcome: 'circuit_open', consecutiveFailures: failures };
    }
    if (runs.some(run => run.status === 'claimed' || (run.taskId && !TERMINAL.has(run.status)))) {
      advance();
      return { scheduleId: schedule.id, outcome: 'skipped_previous_open' };
    }
    const slot = schedule.nextRunAt;
    if (!db().claimRun(schedule.id, slot, iso())) {
      advance();
      return { scheduleId: schedule.id, outcome: 'already_run', slot };
    }
    try {
      const route = await app.submitProjectAgentTask({ personalSpaceId: schedule.personalSpaceId,
        personalProjectId: schedule.personalProjectId, idempotencyKey: `schedule:${schedule.id}:${slot}`,
        title: schedule.body.title, objective: schedule.body.objective, workKind: schedule.body.workKind,
        requiredCapabilities: schedule.body.requiredCapabilities,
        ...(schedule.body.leadAgentId ? { leadAgentId: schedule.body.leadAgentId } : {}),
        start: schedule.body.startMode === 'queue', duration: 'one_off',
        routingReason: `Scheduled task "${schedule.body.title}" for ${slot}.` });
      const task = route?.task ?? route;
      db().finishRun(schedule.id, slot, task?.taskId ?? null, task?.status ?? 'failed');
      advance();
      return { scheduleId: schedule.id, outcome: 'created', slot, taskId: task?.taskId ?? null, status: task?.status ?? null };
    } catch (error) {
      // The routing failure itself counts toward the breaker like a failed task.
      db().finishRun(schedule.id, slot, null, 'failed');
      advance();
      return { scheduleId: schedule.id, outcome: 'failed', slot, error: error?.code ?? 'task_schedule_submit_failed' };
    }
  }

  async function runDue() {
    const results = [];
    for (const schedule of db().due(iso())) results.push(await runSchedule(schedule));
    return results;
  }

  // One tool entry point keeps the full tool list small; each action validates its own fields.
  function manage(input) {
    switch (input.action) {
      case 'create': return create(input);
      case 'update': return update(input);
      case 'pause': return setEnabled(input, false);
      case 'resume': return setEnabled(input, true);
      case 'runs': return { runs: db().runs(owned(input).id, 50) };
      case 'list': return list(input);
      default: throw new TypeError('action must be create, update, pause, resume, list or runs');
    }
  }

  return { manage, runDue, nextDueAt: () => db().nextDueAt(),
    close() { store?.close(); store = null; } };
}

function scheduleBody(input) {
  const every = input.every ?? {};
  if (!Object.hasOwn(UNIT_MS, every.unit)) throw new TypeError('every.unit must be minutes, hours or days');
  const body = {
    title: requiredString(input.title, 'title', 160),
    objective: requiredString(input.objective, 'objective', 4096),
    workKind: requiredString(input.workKind, 'workKind', 128),
    requiredCapabilities: uniqueTextArray(input.requiredCapabilities ?? [], 'requiredCapabilities', 16),
    leadAgentId: input.leadAgentId ? requiredString(input.leadAgentId, 'leadAgentId', 128) : null,
    every: { unit: every.unit, count: positiveInteger(every.count, 'every.count', 1000) },
    startMode: input.startMode ?? 'queue',
    failureThreshold: positiveInteger(input.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD, 'failureThreshold', 10)
  };
  if (!['queue', 'backlog'].includes(body.startMode)) throw new TypeError('startMode must be queue or backlog');
  if (intervalMs(body.every) < MINIMUM_INTERVAL_MS) throw new TypeError('Schedules run at most every 15 minutes');
  return body;
}

function intervalMs(every) { return UNIT_MS[every.unit] * every.count; }

// Missed slots (the console was off) are not replayed: the next slot is the
// first one after now on the schedule's own grid.
function followingSlot(slotIso, every, now) {
  const step = intervalMs(every);
  let next = new Date(slotIso).getTime() + step;
  if (next <= now.getTime()) next += Math.ceil((now.getTime() - next + 1) / step) * step;
  return new Date(next).toISOString();
}
