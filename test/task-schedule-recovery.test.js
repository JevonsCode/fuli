import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createTaskScheduleService } from '../src/task-schedules/service.js';
import { TaskScheduleStore } from '../src/task-schedules/store.js';

// Scenario 3 of rec issue 5: a weekly job is interrupted between saving its
// claim and saving the task ID. Every test crashes one process against a real
// SQLite file and recovers in a new service instance, as a restart would.
const SPACE = 'space-1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Longer than the claim lease, shorter than the hourly interval.
const PAST_CLAIM_LEASE = 10 * MINUTE;
const hourly = { action: 'create', personalSpaceId: SPACE, personalProjectId: 'project-a', title: 'Reading notes',
  objective: 'Organise this week\'s reading notes.', workKind: 'writing', every: { unit: 'hours', count: 1 } };

// The Provider as a schedule sees it: one task per idempotency key, because the
// real Provider derives the task ID from that key.
function fakeProvider() {
  const tasks = new Map();
  const calls = { submit: 0, lookup: 0 };
  let fault = null, lookupFailure = null;
  // The call never answers: the process died while it was in flight.
  const hang = () => new Promise(() => {});
  const app = {
    config: { personal: { spaceId: SPACE } },
    async submitProjectAgentTask(input) {
      calls.submit += 1;
      const point = fault;
      fault = null;
      if (point === 'before_create') return hang();
      if (point instanceof Error) throw point;
      if (!tasks.has(input.idempotencyKey)) {
        tasks.set(input.idempotencyKey, { taskId: `task-${tasks.size + 1}`, status: input.start ? 'queued' : 'backlog' });
      }
      if (point === 'after_create') return hang();
      return { task: { ...tasks.get(input.idempotencyKey) } };
    },
    async findProjectAgentTaskByIdempotencyKey({ idempotencyKey }) {
      calls.lookup += 1;
      if (lookupFailure) throw lookupFailure;
      return tasks.has(idempotencyKey) ? { ...tasks.get(idempotencyKey) } : null;
    },
    async viewProjectAgentTask({ taskId }) {
      return { ...[...tasks.values()].find(task => task.taskId === taskId) };
    }
  };
  return { app, tasks, calls,
    crashOnNextSubmit(point) { fault = point; },
    failNextSubmit(error) { fault = error; },
    failLookups(error) { lookupFailure = error; },
    setStatus(taskId, status) { [...tasks.values()].find(task => task.taskId === taskId).status = status; } };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-schedule-recovery-'));
  const path = join(dir, 'task-schedules.sqlite');
  const provider = fakeProvider();
  const services = [];
  let clock = new Date('2026-10-18T00:00:00.000Z');
  return { provider, path,
    start() {
      const service = createTaskScheduleService({ app: provider.app, now: () => clock,
        openStore: () => new TaskScheduleStore(path) });
      services.push(service);
      return service;
    },
    // The process dies while the submit is in flight; nothing after it runs.
    async crash(service, point) {
      const sent = provider.calls.submit;
      provider.crashOnNextSubmit(point);
      void service.runDue();
      // Every fake call settles in microtasks, so one turn reaches the submit.
      await nextTurn();
      assert.equal(provider.calls.submit, sent + 1, 'the crashed submit reached the Provider');
      service.close();
    },
    advance(ms) { clock = new Date(clock.getTime() + ms); },
    runs: (service, scheduleId) => service.manage({ action: 'runs', personalSpaceId: SPACE, scheduleId }).runs,
    cleanup() { for (const service of services) service.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const unavailable = () => Object.assign(new Error('Graphiti provider is unavailable.'),
  { code: 'provider_unavailable', status: 0 });

test('① a claim that crashed before the Provider created its task is confirmed absent and retried once', async () => {
  const h = harness();
  try {
    const first = h.start();
    const schedule = await first.manage(hourly);
    h.advance(HOUR);
    await h.crash(first, 'before_create');

    const restarted = h.start();
    h.advance(MINUTE);
    // The slot itself is already claimed; its live lease is not taken over.
    assert.deepEqual((await restarted.runDue()).map(result => result.outcome), ['already_run']);
    assert.equal(h.provider.calls.submit, 1);
    const [claim] = h.runs(restarted, schedule.id);
    assert.equal(claim.status, 'claimed');
    assert.equal(restarted.nextDueAt(), claim.leaseExpiresAt, 'the scheduler wakes when the lease runs out');

    h.advance(PAST_CLAIM_LEASE);
    const [recovered] = await restarted.runDue();
    assert.deepEqual([recovered.outcome, recovered.taskId], ['retried', 'task-1']);
    assert.equal(h.provider.calls.submit, 2);
    assert.equal(h.provider.tasks.size, 1);
    const [run] = h.runs(restarted, schedule.id);
    assert.deepEqual([run.taskId, run.status, run.attempts, run.dispatchKey],
      ['task-1', 'queued', 2, `schedule:${schedule.id}:${schedule.nextRunAt}`]);

    h.provider.setStatus('task-1', 'completed');
    h.advance(HOUR);
    const [next] = await restarted.runDue();
    assert.equal(next.outcome, 'created', 'the following slot is not skipped forever');
    assert.equal(h.provider.tasks.size, 2);
  } finally { h.cleanup(); }
});

test('② a task created before the acknowledgement was lost is found by its key and adopted, not created twice', async () => {
  const h = harness();
  try {
    const first = h.start();
    const schedule = await first.manage(hourly);
    h.advance(HOUR);
    await h.crash(first, 'after_create');

    const restarted = h.start();
    h.advance(PAST_CLAIM_LEASE);
    const [recovered] = await restarted.runDue();
    assert.deepEqual([recovered.outcome, recovered.taskId], ['adopted', 'task-1']);
    assert.equal(h.provider.calls.submit, 1, 'no second submit');
    const [run] = h.runs(restarted, schedule.id);
    assert.deepEqual([run.taskId, run.status, run.progress], ['task-1', 'queued', 'adopted']);

    h.advance(HOUR);
    assert.equal((await restarted.runDue())[0].outcome, 'skipped_previous_open', 'the adopted task is tracked');
    h.provider.setStatus('task-1', 'completed');
    h.advance(HOUR);
    assert.equal((await restarted.runDue())[0].outcome, 'created');
    assert.deepEqual([...h.provider.tasks.keys()].length, 2, 'each slot has at most one task');
  } finally { h.cleanup(); }
});

test('③ a task ID saved before the crash is tracked by the new process without any lookup', async () => {
  const h = harness();
  try {
    const first = h.start();
    const schedule = await first.manage(hourly);
    h.advance(HOUR);
    assert.equal((await first.runDue())[0].outcome, 'created');
    first.close();

    const restarted = h.start();
    h.provider.setStatus('task-1', 'running');
    h.advance(HOUR);
    assert.equal((await restarted.runDue())[0].outcome, 'skipped_previous_open');
    h.provider.setStatus('task-1', 'completed');
    h.advance(HOUR);
    assert.equal((await restarted.runDue())[0].outcome, 'created');
    assert.equal(h.provider.calls.lookup, 0);
    assert.deepEqual(h.runs(restarted, schedule.id).map(run => run.status), ['queued', 'completed']);
  } finally { h.cleanup(); }
});

test('an outcome that cannot be checked stays unresolved and visible instead of being sent again', async () => {
  const h = harness();
  try {
    const first = h.start();
    const schedule = await first.manage(hourly);
    h.advance(HOUR);
    await h.crash(first, 'before_create');

    const restarted = h.start();
    h.provider.failLookups(unavailable());
    h.advance(PAST_CLAIM_LEASE);
    const [unchecked] = await restarted.runDue();
    assert.equal(unchecked.outcome, 'unresolved');
    let [run] = h.runs(restarted, schedule.id);
    assert.deepEqual([run.status, run.taskId, run.lastError], ['unresolved', null, 'provider_unavailable']);

    h.advance(HOUR);
    const outcomes = (await restarted.runDue()).map(result => result.outcome);
    assert.deepEqual(outcomes, ['unresolved', 'skipped_previous_unresolved']);
    assert.equal(h.provider.calls.submit, 1, 'never a blind resend');

    h.provider.failLookups(null);
    h.advance(PAST_CLAIM_LEASE);
    const [settled] = await restarted.runDue();
    assert.deepEqual([settled.outcome, settled.taskId], ['retried', 'task-1']);
    [run] = h.runs(restarted, schedule.id);
    assert.deepEqual([run.status, run.lastError], ['queued', null]);
  } finally { h.cleanup(); }
});

test('a submit that timed out is unresolved, then adopted when the Provider did create the task', async () => {
  const h = harness();
  try {
    const service = h.start();
    const schedule = await service.manage(hourly);
    h.advance(HOUR);
    // The Provider commits, then the response is lost to the timeout.
    const created = h.provider.app.submitProjectAgentTask;
    h.provider.app.submitProjectAgentTask = async (input) => {
      await created(input);
      throw Object.assign(new Error('Graphiti provider request timed out.'), { code: 'provider_timeout', status: 504 });
    };
    const [timedOut] = await service.runDue();
    assert.equal(timedOut.outcome, 'unresolved');
    h.provider.app.submitProjectAgentTask = created;
    h.advance(PAST_CLAIM_LEASE);
    const [adopted] = await service.runDue();
    assert.deepEqual([adopted.outcome, adopted.taskId], ['adopted', 'task-1']);
    assert.equal(h.provider.calls.submit, 1);
    assert.equal(h.runs(service, schedule.id)[0].taskId, 'task-1');
  } finally { h.cleanup(); }
});

test('a claim that is still absent after its one retry fails instead of retrying again', async () => {
  const h = harness();
  try {
    const first = h.start();
    const schedule = await first.manage({ ...hourly, failureThreshold: 1 });
    h.advance(HOUR);
    await h.crash(first, 'before_create');
    const second = h.start();
    h.advance(PAST_CLAIM_LEASE);
    await h.crash(second, 'before_create');

    const third = h.start();
    h.advance(PAST_CLAIM_LEASE);
    const [gaveUp, breaker] = await third.runDue();
    assert.deepEqual([gaveUp.outcome, gaveUp.error], ['failed', 'task_schedule_not_created']);
    assert.equal(breaker.outcome, 'circuit_open', 'the failure counts toward the breaker');
    assert.equal(h.provider.calls.submit, 2);
    assert.equal(h.runs(third, schedule.id)[0].status, 'failed');
  } finally { h.cleanup(); }
});

test('a paused schedule creates nothing; its interrupted claim is reconciled after resume', async () => {
  const h = harness();
  try {
    const first = h.start();
    const schedule = await first.manage(hourly);
    h.advance(HOUR);
    await h.crash(first, 'before_create');

    const restarted = h.start();
    const paused = restarted.manage({ action: 'pause', personalSpaceId: SPACE, scheduleId: schedule.id,
      expectedRevision: schedule.revision });
    h.advance(PAST_CLAIM_LEASE);
    assert.deepEqual(await restarted.runDue(), []);
    assert.deepEqual([h.provider.calls.lookup, h.provider.calls.submit], [0, 1]);

    restarted.manage({ action: 'resume', personalSpaceId: SPACE, scheduleId: schedule.id, expectedRevision: paused.revision });
    const [recovered] = await restarted.runDue();
    assert.deepEqual([recovered.outcome, recovered.taskId], ['retried', 'task-1']);
  } finally { h.cleanup(); }
});

test('a claim left by an earlier version is reconciled after the upgrade and existing rows still read', async () => {
  const h = harness();
  try {
    const old = new DatabaseSync(h.path);
    old.exec(`CREATE TABLE task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
        revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
        paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, breaker_reset_at TEXT);
      CREATE TABLE task_schedule_runs(schedule TEXT NOT NULL, slot TEXT NOT NULL, task_id TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(schedule, slot));`);
    const body = { title: 'Reading notes', objective: 'Organise notes.', workKind: 'writing', requiredCapabilities: [],
      leadAgentId: null, every: { unit: 'hours', count: 1 }, startMode: 'queue', failureThreshold: 3 };
    old.prepare('INSERT INTO task_schedules VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('s-1', SPACE, 'project-a', 3, 1,
      JSON.stringify(body), '2026-10-18T02:00:00.000Z', null, 'x', 'x', null);
    const insertRun = old.prepare('INSERT INTO task_schedule_runs VALUES(?,?,?,?,?)');
    insertRun.run('s-1', '2026-10-17T23:00:00.000Z', 'task-old', 'completed', '2026-10-17T23:00:01.000Z');
    insertRun.run('s-1', '2026-10-18T00:00:00.000Z', null, 'claimed', '2026-10-18T00:00:01.000Z');
    old.close();
    h.provider.tasks.set('schedule:s-1:2026-10-18T00:00:00.000Z', { taskId: 'task-lost-ack', status: 'running' });

    const service = h.start();
    h.advance(PAST_CLAIM_LEASE);
    const [recovered] = await service.runDue();
    assert.deepEqual([recovered.outcome, recovered.taskId], ['adopted', 'task-lost-ack']);
    const runs = h.runs(service, 's-1');
    assert.deepEqual(runs.map(run => [run.taskId, run.status]),
      [['task-lost-ack', 'running'], ['task-old', 'completed']]);
    assert.equal(runs[1].dispatchKey, 'schedule:s-1:2026-10-17T23:00:00.000Z');
    assert.equal(h.provider.calls.submit, 0);
  } finally { h.cleanup(); }
});
