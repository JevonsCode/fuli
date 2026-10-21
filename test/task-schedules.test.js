import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskScheduleService } from '../src/task-schedules/service.js';
import { startTaskScheduler } from '../src/task-schedules/scheduler.js';
import { newerFormatError } from '../packages/roundtable/src/storage/data-format-error.js';

const SPACE = 'space-1';
function fixture() {
  let clock = new Date('2026-10-19T00:00:00.000Z');
  const submitted = [], statuses = new Map();
  let failSubmit = false, nextId = 0;
  const app = {
    config: { personal: { spaceId: SPACE } },
    async submitProjectAgentTask(input) {
      // The Provider answered and refused the task, so nothing was created.
      if (failSubmit) throw Object.assign(new Error('routing failed'), { code: 'synthetic_failure', status: 422 });
      submitted.push(input);
      const taskId = `task-${++nextId}`;
      statuses.set(taskId, input.start ? 'queued' : 'backlog');
      return { task: { taskId, status: statuses.get(taskId) } };
    },
    async viewProjectAgentTask({ taskId }) { return { taskId, status: statuses.get(taskId) }; }
  };
  const service = createTaskScheduleService({ app, now: () => clock });
  return { app, service, submitted, statuses,
    advance(ms) { clock = new Date(clock.getTime() + ms); },
    failSubmit(value) { failSubmit = value; } };
}
const hourly = { action: 'create', personalSpaceId: SPACE, personalProjectId: 'project-a', title: 'Nightly check',
  objective: 'Run the checks and report.', workKind: 'verification', every: { unit: 'hours', count: 1 } };
const HOUR = 3_600_000;

test('schedules reject intervals under 15 minutes and unknown start modes', async () => {
  const { service } = fixture();
  await assert.rejects(() => service.manage({ ...hourly, every: { unit: 'minutes', count: 5 } }), /15 minutes/);
  await assert.rejects(() => service.manage({ ...hourly, startMode: 'now' }), /startMode/);
  await assert.rejects(() => service.manage({ ...hourly, every: { unit: 'weeks', count: 1 } }), /every.unit/);
});

test('each due slot creates one task through normal routing and the next slot moves past now', async () => {
  const f = fixture();
  const created = await f.service.manage({ ...hourly, startMode: 'backlog' });
  assert.deepEqual(await f.service.runDue(), []);
  f.advance(HOUR);
  const [first] = await f.service.runDue();
  assert.equal(first.outcome, 'created');
  assert.equal(f.submitted[0].idempotencyKey, `schedule:${created.id}:${created.nextRunAt}`);
  assert.equal(f.submitted[0].start, false);
  assert.equal(f.submitted[0].personalProjectId, 'project-a');
  assert.deepEqual(await f.service.runDue(), []);
  const [schedule] = f.service.manage({ action: 'list', personalSpaceId: SPACE }).schedules;
  assert.equal(schedule.nextRunAt, '2026-10-19T02:00:00.000Z');
  assert.equal(schedule.recentRuns[0].taskId, 'task-1');
});

test('a slot is skipped while the previous scheduled task is still open', async () => {
  const f = fixture();
  await f.service.manage(hourly);
  f.advance(HOUR); await f.service.runDue();
  f.statuses.set('task-1', 'running');
  f.advance(HOUR);
  const [second] = await f.service.runDue();
  assert.equal(second.outcome, 'skipped_previous_open');
  assert.equal(f.submitted.length, 1);
  f.statuses.set('task-1', 'completed');
  f.advance(HOUR);
  assert.equal((await f.service.runDue())[0].outcome, 'created');
});

test('consecutive failures open the circuit; a success in between resets it; resume closes it', async () => {
  const f = fixture();
  const created = await f.service.manage({ ...hourly, failureThreshold: 2 });
  for (const status of ['failed', 'completed', 'failed', 'failed']) {
    f.advance(HOUR);
    const [result] = await f.service.runDue();
    assert.equal(result.outcome, 'created');
    f.statuses.set(result.taskId, status);
  }
  f.advance(HOUR);
  const [opened] = await f.service.runDue();
  assert.equal(opened.outcome, 'circuit_open');
  assert.equal(opened.consecutiveFailures, 2);
  let [schedule] = f.service.manage({ action: 'list', personalSpaceId: SPACE }).schedules;
  assert.equal(schedule.enabled, false);
  assert.equal(schedule.pausedReason, 'circuit_open');
  f.advance(HOUR);
  assert.deepEqual(await f.service.runDue(), []);
  schedule = f.service.manage({ action: 'resume', personalSpaceId: SPACE, scheduleId: created.id, expectedRevision: schedule.revision });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.pausedReason, null);
  assert.throws(() => f.service.manage({ action: 'pause', personalSpaceId: SPACE, scheduleId: created.id, expectedRevision: 1 }), /changed/);
  // Failures before the resume no longer count: the next slot creates a task instead of tripping again.
  f.advance(HOUR);
  const [afterResume] = await f.service.runDue();
  assert.equal(afterResume.outcome, 'created');
  f.statuses.set(afterResume.taskId, 'failed');
  f.advance(HOUR);
  assert.equal((await f.service.runDue())[0].outcome, 'created');
});

test('a schedule store from before the breaker reset column still opens and resumes', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { TaskScheduleStore } = await import('../src/task-schedules/store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'fuli-schedules-'));
  try {
    const path = join(dir, 'task-schedules.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
      revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
      paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.prepare('INSERT INTO task_schedules VALUES(?,?,?,?,?,?,?,?,?,?)').run('s-1', SPACE, 'project-a', 1, 0,
      JSON.stringify({ every: { unit: 'hours', count: 1 } }), '2026-10-19T01:00:00.000Z', 'circuit_open', 'x', 'x');
    old.close();
    const store = new TaskScheduleStore(path);
    assert.equal(store.get('s-1').breakerResetAt, null);
    const resumed = store.update('s-1', 1, { enabled: true, pausedReason: null, breakerResetAt: '2026-10-19T02:00:00.000Z' }, 'y');
    assert.equal(resumed.breakerResetAt, '2026-10-19T02:00:00.000Z');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a routing failure counts toward the breaker like a failed task', async () => {
  const f = fixture();
  await f.service.manage({ ...hourly, failureThreshold: 1 });
  f.failSubmit(true);
  f.advance(HOUR);
  assert.equal((await f.service.runDue())[0].outcome, 'failed');
  f.advance(HOUR);
  assert.equal((await f.service.runDue())[0].outcome, 'circuit_open');
});

test('missed slots are not replayed after the console was off', async () => {
  const f = fixture();
  await f.service.manage(hourly);
  f.advance(10 * HOUR + 60_000);
  const results = await f.service.runDue();
  assert.equal(results.length, 1);
  const [schedule] = f.service.manage({ action: 'list', personalSpaceId: SPACE }).schedules;
  assert.equal(schedule.nextRunAt, '2026-10-19T11:00:00.000Z');
});

test('schedules of another space are invisible', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.manage({ ...hourly, personalSpaceId: 'other' }), /not found/);
  assert.deepEqual(f.service.manage({ action: 'list', personalSpaceId: 'other' }).schedules, []);
});

test('the scheduler sleeps until the next due schedule and runs under the lease', async () => {
  const timers = [], leases = [];
  let runs = 0;
  const app = { taskSchedules: { nextDueAt: () => new Date(Date.now() + 120_000).toISOString(),
    runDue: async () => { runs += 1; return []; } } };
  const stop = startTaskScheduler({ app, withLease: (owner, run) => { leases.push(owner); return run(); },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimer: () => {} });
  assert.ok(timers[0].ms > 100_000 && timers[0].ms <= 120_000);
  await timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.deepEqual(leases, ['task-schedules:run']);
  assert.equal(timers.length, 2);
  await stop();
});

test('a schedule store this version cannot use leaves the scheduler waiting, not crashed (rec#17)', async () => {
  const timers = [];
  let runs = 0;
  const app = { taskSchedules: { nextDueAt: () => { throw newerFormatError('task-schedules', 9, 3); },
    runDue: async () => { runs += 1; throw newerFormatError('task-schedules', 9, 3); } } };
  const stop = startTaskScheduler({ app, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimer: () => {} });
  assert.equal(timers[0].ms, 15 * 60_000);
  await timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(timers.length, 2);
  await stop();
});

test('update changes only the fields it names and needs the current revision', async () => {
  const f = fixture();
  const created = await f.service.manage(hourly);
  const updated = f.service.manage({ action: 'update', personalSpaceId: SPACE, scheduleId: created.id,
    expectedRevision: created.revision, startMode: 'backlog', every: { unit: 'days', count: 1 } });
  assert.equal(updated.body.startMode, 'backlog');
  assert.equal(updated.body.title, 'Nightly check');
  assert.deepEqual(updated.body.every, { unit: 'days', count: 1 });
  assert.throws(() => f.service.manage({ action: 'update', personalSpaceId: SPACE, scheduleId: created.id,
    expectedRevision: created.revision, title: 'Stale' }), /changed/);
});
