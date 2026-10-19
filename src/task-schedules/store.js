import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Local schedules that create project Agent tasks. Each slot creates at most
// one task (the run row is the dedupe key); the task itself lives in the Provider.
export class TaskScheduleStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS task_schedules(id TEXT PRIMARY KEY, space TEXT NOT NULL, project TEXT NOT NULL,
        revision INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL, next_run_at TEXT NOT NULL,
        paused_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_schedule_runs(schedule TEXT NOT NULL, slot TEXT NOT NULL, task_id TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(schedule, slot));`);
    // Added after the first release: when a person last resumed the schedule.
    const columns = this.db.prepare('PRAGMA table_info(task_schedules)').all().map(column => column.name);
    if (!columns.includes('breaker_reset_at')) this.db.exec('ALTER TABLE task_schedules ADD COLUMN breaker_reset_at TEXT');
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

  nextDueAt() {
    return this.db.prepare('SELECT MIN(next_run_at) AS at FROM task_schedules WHERE enabled=1').get()?.at ?? null;
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

  claimRun(schedule, slot, at) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO task_schedule_runs VALUES(?,?,?,?,?)`)
      .run(schedule, slot, null, 'claimed', at);
    return result.changes === 1;
  }

  finishRun(schedule, slot, taskId, status) {
    this.db.prepare('UPDATE task_schedule_runs SET task_id=?, status=? WHERE schedule=? AND slot=?')
      .run(taskId, status, schedule, slot);
  }

  runs(schedule, limit = 20) {
    return this.db.prepare('SELECT slot, task_id, status, created_at FROM task_schedule_runs WHERE schedule=? ORDER BY slot DESC LIMIT ?')
      .all(schedule, limit).map(row => ({ slot: row.slot, taskId: row.task_id, status: row.status, createdAt: row.created_at }));
  }

  close() { this.db.close(); }
}

function view(row) {
  if (!row) return null;
  return { id: row.id, personalSpaceId: row.space, personalProjectId: row.project, revision: row.revision,
    enabled: row.enabled === 1, body: JSON.parse(row.body), nextRunAt: row.next_run_at, pausedReason: row.paused_reason,
    breakerResetAt: row.breaker_reset_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
}
