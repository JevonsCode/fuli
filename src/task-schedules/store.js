import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Run columns added after the first release, when a claim became recoverable.
const RUN_RECOVERY_COLUMNS = Object.freeze({ dispatch_key: 'TEXT', claimed_by: 'TEXT', lease_expires_at: 'TEXT',
  attempts: 'INTEGER NOT NULL DEFAULT 1', progress: 'TEXT', last_error: 'TEXT', updated_at: 'TEXT' });
const RUN_FIELDS = Object.freeze({ taskId: 'task_id', status: 'status', claimedBy: 'claimed_by',
  leaseExpiresAt: 'lease_expires_at', attempts: 'attempts', progress: 'progress', lastError: 'last_error' });
// A claim without a task ID is still being created, or waits for reconciliation.
const OPEN_CLAIM = "task_id IS NULL AND status IN ('claimed','unresolved')";
// Checked in the same statement that claims or retries, so a pause saved by any
// process meanwhile wins over a scan or a lookup that started before it.
const SCHEDULE_ENABLED = 'EXISTS (SELECT 1 FROM task_schedules WHERE id = task_schedule_runs.schedule AND enabled = 1)';
export const TASK_SCHEDULE_FORMAT = sqliteFormat({
  store: 'task-schedules',
  schema: `
    CREATE TABLE IF NOT EXISTS task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
      revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
      paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_schedule_runs(schedule TEXT NOT NULL, slot TEXT NOT NULL, task_id TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(schedule, slot));`,
  migrations: [{
    id: 'task-schedules/2-breaker-reset', to: 2, kind: 'add-columns', table: 'task_schedules',
    summary: 'when a person last resumed the schedule', columns: { breaker_reset_at: 'TEXT' }
  }, {
    // Rows from before recovery read as rows written now: the key the slot was
    // always submitted with, and an expired lease, so an old open claim is reconciled.
    id: 'task-schedules/3-run-recovery', to: 3, kind: 'backfill', table: 'task_schedule_runs',
    summary: 'recoverable claims: a dispatch key and an expired lease on every earlier run',
    columns: RUN_RECOVERY_COLUMNS,
    // A run is named by its schedule and row, never by its slot.
    backfillKeys: (db) => db.prepare("SELECT schedule || '#' || rowid AS key FROM task_schedule_runs ORDER BY key").all()
      .map((row) => row.key),
    backfill(db) {
      const backfill = db.prepare(`UPDATE task_schedule_runs SET dispatch_key=?, lease_expires_at=created_at,
        updated_at=created_at WHERE schedule=? AND slot=?`);
      for (const row of db.prepare('SELECT schedule, slot FROM task_schedule_runs').all()) {
        backfill.run(dispatchKey(row.schedule, row.slot), row.schedule, row.slot);
      }
    }
  }]
});

// Local schedules that create project Agent tasks. Each slot creates at most
// one task: the run row and its dispatch key are the dedupe key, and the
// Provider derives the task from that key; the task itself lives in the Provider.
export class TaskScheduleStore {
  constructor(path = ':memory:') {
    this.db = openFormattedDatabase(path, TASK_SCHEDULE_FORMAT);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  insert(schedule) {
    this.db.prepare(`INSERT INTO task_schedules(id, space, project, revision, enabled, body, next_run_at, paused_reason,
      created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(schedule.id, schedule.space,
      schedule.project, 1, schedule.enabled ? 1 : 0, JSON.stringify(schedule.body), schedule.nextRunAt, null,
      schedule.at, schedule.at);
    return this.get(schedule.id);
  }

  get(id) {
    return view(this.db.prepare('SELECT * FROM task_schedules WHERE id=?').get(id));
  }

  list(space, project = null) {
    const rows = project
      ? this.db.prepare('SELECT * FROM task_schedules WHERE space=? AND project=? ORDER BY created_at').all(space, project)
      : this.db.prepare('SELECT * FROM task_schedules WHERE space=? ORDER BY created_at').all(space);
    return rows.map(view);
  }

  due(nowIso) {
    return this.db.prepare('SELECT * FROM task_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at')
      .all(nowIso).map(view);
  }

  // The next slot or claim lease that needs a pass, whichever comes first.
  nextDueAt() {
    return this.db.prepare(`SELECT MIN(at) AS at FROM (
        SELECT next_run_at AS at FROM task_schedules WHERE enabled=1
        UNION ALL SELECT run.lease_expires_at FROM task_schedule_runs run JOIN task_schedules schedule
          ON schedule.id = run.schedule WHERE schedule.enabled=1 AND run.${OPEN_CLAIM})`).get()?.at ?? null;
  }

  // Optimistic update: a stale revision changes nothing and returns null.
  update(id, expectedRevision, { body, enabled, nextRunAt, pausedReason, breakerResetAt }, at) {
    const current = this.get(id);
    if (!current || current.revision !== expectedRevision) return null;
    this.db.prepare(`UPDATE task_schedules SET revision=?, enabled=?, body=?, next_run_at=?, paused_reason=?,
      breaker_reset_at=?, updated_at=? WHERE id=? AND revision=?`).run(expectedRevision + 1, (enabled ?? current.enabled) ? 1 : 0,
      JSON.stringify(body ?? current.body), nextRunAt ?? current.nextRunAt,
      pausedReason === undefined ? current.pausedReason : pausedReason, breakerResetAt ?? current.breakerResetAt,
      at, id, expectedRevision);
    return this.get(id);
  }

  // Saved before the first submit, so a crash leaves a claim that says a send may
  // have happened. Returns the claimed run, or null when the slot was already
  // claimed or the schedule is no longer enabled.
  claimRun(schedule, slot, { claimedBy, leaseExpiresAt, at }) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO task_schedule_runs(schedule, slot, task_id, status, created_at,
      dispatch_key, claimed_by, lease_expires_at, attempts, progress, updated_at)
      SELECT ?,?,NULL,'claimed',?,?,?,?,1,'submitting',? WHERE EXISTS (SELECT 1 FROM task_schedules WHERE id=? AND enabled=1)`)
      .run(schedule, slot, at, dispatchKey(schedule, slot), claimedBy, leaseExpiresAt, at, schedule);
    return result.changes === 1
      ? runView(this.db.prepare('SELECT * FROM task_schedule_runs WHERE schedule=? AND slot=?').get(schedule, slot))
      : null;
  }

  // Open claims of enabled schedules whose lease has run out: their claimer died or never answered.
  abandonedRuns(nowIso) {
    return this.db.prepare(`SELECT run.* FROM task_schedule_runs run JOIN task_schedules schedule ON schedule.id = run.schedule
      WHERE schedule.enabled=1 AND run.${OPEN_CLAIM} AND run.lease_expires_at<=? ORDER BY run.slot`).all(nowIso).map(runView);
  }

  // Takes over an abandoned claim; false when another process already did or the schedule was paused.
  takeOverRun(schedule, slot, { claimedBy, leaseExpiresAt, at }) {
    const result = this.db.prepare(`UPDATE task_schedule_runs SET claimed_by=?, lease_expires_at=?, progress='reconciling',
      updated_at=? WHERE schedule=? AND slot=? AND ${OPEN_CLAIM} AND lease_expires_at<=? AND ${SCHEDULE_ENABLED}`)
      .run(claimedBy, leaseExpiresAt, at, schedule, slot, at);
    return result.changes === 1;
  }

  // Counts the one retry of a claim this claimer holds; false once the schedule was paused.
  retryRun(schedule, slot, { claimedBy, at }) {
    const result = this.db.prepare(`UPDATE task_schedule_runs SET status='claimed', attempts=attempts+1, progress='retrying',
      updated_at=? WHERE schedule=? AND slot=? AND task_id IS NULL AND claimed_by=? AND ${SCHEDULE_ENABLED}`)
      .run(at, schedule, slot, claimedBy);
    return result.changes === 1;
  }

  updateRun(schedule, slot, changes, at) {
    const fields = Object.keys(changes);
    for (const field of fields) if (!Object.hasOwn(RUN_FIELDS, field)) throw new TypeError(`Unknown run field ${field}`);
    this.db.prepare(`UPDATE task_schedule_runs SET ${fields.map(field => `${RUN_FIELDS[field]}=?`).join(', ')}, updated_at=?
      WHERE schedule=? AND slot=?`).run(...fields.map(field => changes[field]), at, schedule, slot);
  }

  runs(schedule, limit = 20) {
    return this.db.prepare('SELECT * FROM task_schedule_runs WHERE schedule=? ORDER BY slot DESC LIMIT ?')
      .all(schedule, limit).map(runView);
  }

  close() { this.db.close(); }
}

// The idempotency key every submit of a slot carries, also before this column existed.
function dispatchKey(schedule, slot) { return `schedule:${schedule}:${slot}`; }

function view(row) {
  if (!row) return null;
  return { id: row.id, personalSpaceId: row.space, personalProjectId: row.project, revision: row.revision,
    enabled: row.enabled === 1, body: JSON.parse(row.body), nextRunAt: row.next_run_at, pausedReason: row.paused_reason,
    breakerResetAt: row.breaker_reset_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
}

function runView(row) {
  return { scheduleId: row.schedule, slot: row.slot, taskId: row.task_id, status: row.status, createdAt: row.created_at,
    dispatchKey: row.dispatch_key, claimedBy: row.claimed_by, leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts, progress: row.progress, lastError: row.last_error, updatedAt: row.updated_at };
}
