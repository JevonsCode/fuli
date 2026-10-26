import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { contentHash } from '../../../../packages/roundtable/src/canonical-json.js';
import { openFormattedDatabase, sqliteFormat } from '../../../../packages/roundtable/src/storage/database-format.js';
import { EmployeeError } from '../../manifest.js';

// Jefa's task board, built into FULI. One file under the
// employee data directory (employees/data/jefa/board.sqlite), separate from
// the employee management policy. Every row is keyed by personal space and
// project; callers pass the project FULI authorized, never one from a request.
//
// Temporal history: jefa_work_items holds each task's current state and every
// change appends the state it produced to jefa_work_item_revisions in the same
// transaction. Revisions are immutable, so a task can always be read back to
// who changed it and when. Tasks are never deleted.
export const JEFA_BOARD_FORMAT = sqliteFormat({
  store: 'jefa-board',
  schema: `
      CREATE TABLE IF NOT EXISTS jefa_projects(
        space_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
        share_slug TEXT, share_enabled_at TEXT, PRIMARY KEY(space_id, project_id));
      CREATE TABLE IF NOT EXISTS jefa_work_items(
        space_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('planned', 'active', 'blocked', 'review', 'done')),
        priority TEXT NOT NULL CHECK(priority IN ('critical', 'high', 'medium', 'low')),
        visibility TEXT NOT NULL CHECK(visibility IN ('private', 'public_summary')),
        work_type TEXT, acceptance_criteria TEXT NOT NULL, tags TEXT NOT NULL, accepted_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(space_id, project_id, id));
      CREATE TABLE IF NOT EXISTS jefa_work_item_revisions(
        space_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('agent', 'person')), record TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(space_id, project_id, id, revision));
      CREATE TRIGGER IF NOT EXISTS jefa_work_item_revisions_no_update BEFORE UPDATE ON jefa_work_item_revisions
        BEGIN SELECT RAISE(ABORT, 'Jefa task revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS jefa_work_item_revisions_no_delete BEFORE DELETE ON jefa_work_item_revisions
        BEGIN SELECT RAISE(ABORT, 'Jefa task revisions are immutable'); END;
      CREATE TABLE IF NOT EXISTS jefa_requests(
        space_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL,
        digest TEXT NOT NULL, result TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(space_id, project_id, kind, request_id));
      CREATE TABLE IF NOT EXISTS jefa_session_titles(
        space_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL,
        source_application TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
        record TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(space_id, project_id, id),
        UNIQUE(space_id, project_id, source_application, session_id));`,
  pragmas: 'PRAGMA journal_mode = WAL;'
});

const STATUS_ORDER = ['active', 'blocked', 'review', 'planned', 'done'];
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];
const BOARD_ORDER = `ORDER BY
  CASE status ${STATUS_ORDER.map((status, index) => `WHEN '${status}' THEN ${index}`).join(' ')} END,
  CASE priority ${PRIORITY_ORDER.map((priority, index) => `WHEN '${priority}' THEN ${index}`).join(' ')} END,
  updated_at DESC, id`;
// The slug the public report link carries (shared-report.ts accepts share-[a-zA-Z0-9-]{16,100}).
const SHARE_SLUG_BYTES = 18;
const TASK_HISTORY_LIMIT = 20;

export class JefaBoardStore {
  #database = null;
  constructor(path, { now = () => new Date() } = {}) {
    this.path = path;
    this.now = now;
  }

  // Opened on first use: a store this version cannot use (rec#17) fails the
  // board calls that need it, not the console that hosts them.
  get database() {
    this.#database ??= openFormattedDatabase(this.path, JEFA_BOARD_FORMAT);
    return this.#database;
  }

  board(scope, { limit, statuses }) {
    const filter = statuses?.length ? `AND status IN (${statuses.map(() => '?').join(', ')})` : '';
    const parameters = [scope.spaceId, scope.projectId, ...(statuses ?? [])];
    const rows = this.database.prepare(`SELECT * FROM jefa_work_items WHERE space_id = ? AND project_id = ? ${filter}
      ${BOARD_ORDER} LIMIT ?`).all(...parameters, limit + 1);
    const { total } = this.database.prepare(`SELECT count(*) AS total FROM jefa_work_items
      WHERE space_id = ? AND project_id = ? ${filter}`).get(...parameters);
    return { version: this.#projectRevision(scope), total, truncated: rows.length > limit,
      items: rows.slice(0, limit).map(itemFromRow) };
  }

  items(scope) {
    return this.database.prepare(`SELECT * FROM jefa_work_items WHERE space_id = ? AND project_id = ? ${BOARD_ORDER}`)
      .all(scope.spaceId, scope.projectId).map(itemFromRow);
  }

  item(scope, id) {
    const item = itemFromRow(this.#row(scope, id));
    const history = this.database.prepare(`SELECT revision, actor, record, recorded_at FROM jefa_work_item_revisions
      WHERE space_id = ? AND project_id = ? AND id = ? ORDER BY revision DESC LIMIT ?`)
      .all(scope.spaceId, scope.projectId, id, TASK_HISTORY_LIMIT)
      .map((row) => ({ revision: row.revision, actor: row.actor, status: JSON.parse(row.record).status, recordedAt: row.recorded_at }));
    return { ...item, history };
  }

  // tasks: validated task fields; visibility defaults to private.
  create(scope, { requestId, tasks, actor }) {
    return this.#once(scope, 'create', requestId, tasks, () => tasks.map((task) => {
      const at = this.now().toISOString();
      const item = { id: randomUUID(), projectId: scope.projectId, title: task.title, summary: task.summary ?? '',
        status: task.status ?? 'planned', priority: task.priority ?? 'medium', visibility: task.visibility ?? 'private',
        workType: task.workType, acceptanceCriteria: task.acceptanceCriteria ?? [], tags: task.tags ?? [],
        createdAt: at, updatedAt: at };
      return this.#write(scope, item, 1, actor);
    }));
  }

  // Every update names the updatedAt it read; one stale update refuses the whole request.
  update(scope, { requestId, updates, actor }) {
    return this.#once(scope, 'update', requestId, updates, () => updates.map(({ id, expectedUpdatedAt, ...change }) => {
      const row = this.#row(scope, id);
      if (row.updated_at !== expectedUpdatedAt) {
        throw new EmployeeError('The task changed since it was read; read it again before updating', 409, 'version_conflict');
      }
      const current = itemFromRow(row);
      const item = { ...current, ...change, updatedAt: this.#nextTime(current.updatedAt) };
      if (change.status && change.status !== current.status) item.acceptedAt = change.status === 'done' ? item.updatedAt : undefined;
      return this.#write(scope, item, row.revision + 1, actor);
    }));
  }

  // The person's own move, from the console: no version check, as the board shows it.
  setStatus(scope, id, status) {
    return this.#transaction(() => {
      const row = this.#row(scope, id);
      const current = itemFromRow(row);
      if (current.status === status) return current;
      const updatedAt = this.#nextTime(current.updatedAt);
      const item = { ...current, status, updatedAt, acceptedAt: status === 'done' ? updatedAt : undefined };
      return this.#write(scope, item, row.revision + 1, 'person');
    });
  }

  sharing(scope) {
    const row = this.database.prepare('SELECT share_slug FROM jefa_projects WHERE space_id = ? AND project_id = ?')
      .get(scope.spaceId, scope.projectId);
    return shareState(scope.projectId, row?.share_slug);
  }

  // Enabling keeps an existing slug; disabling drops it, so an old link stops working.
  setSharing(scope, enabled) {
    return this.#transaction(() => {
      const current = this.sharing(scope);
      if (current.publicShareEnabled === enabled) return current;
      const slug = enabled ? `share-${randomBytes(SHARE_SLUG_BYTES).toString('hex')}` : null;
      this.#bumpProject(scope, { slug, enabledAt: enabled ? this.now().toISOString() : null });
      return shareState(scope.projectId, slug);
    });
  }

  // Only tasks marked public_summary, and only their title, status and priority.
  publicItems(scope, slug) {
    const { publicShareSlug } = this.sharing(scope);
    if (!publicShareSlug || !sameText(publicShareSlug, slug)) return null;
    return this.database.prepare(`SELECT id, title, status, priority FROM jefa_work_items
      WHERE space_id = ? AND project_id = ? AND visibility = 'public_summary' ${BOARD_ORDER}`)
      .all(scope.spaceId, scope.projectId).map((row) => ({ ...row }));
  }

  titleRecord(scope, { sourceApplication, sessionId, recordId }) {
    const row = recordId
      ? this.database.prepare('SELECT record FROM jefa_session_titles WHERE space_id = ? AND project_id = ? AND id = ?')
        .get(scope.spaceId, scope.projectId, recordId)
      : this.database.prepare(`SELECT record FROM jefa_session_titles
          WHERE space_id = ? AND project_id = ? AND source_application = ? AND session_id = ?`)
        .get(scope.spaceId, scope.projectId, sourceApplication, sessionId);
    return row ? JSON.parse(row.record) : null;
  }

  // build(previous) returns the next record; its revision must follow the previous one.
  saveTitleRecord(scope, { requestId, request, sourceApplication, sessionId, recordId }, build) {
    const write = () => {
      const previous = this.titleRecord(scope, { sourceApplication, sessionId, recordId });
      const record = build(previous, this.now().toISOString());
      this.database.prepare(`INSERT INTO jefa_session_titles(space_id, project_id, id, source_application, session_id,
          revision, record, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(space_id, project_id, id) DO UPDATE SET revision = excluded.revision, record = excluded.record,
          updated_at = excluded.updated_at`)
        .run(scope.spaceId, scope.projectId, record.id, record.sourceApplication, record.sessionId,
          record.revision, JSON.stringify(record), record.updatedAt);
      return record;
    };
    return requestId ? this.#once(scope, 'title', requestId, request, write) : this.#transaction(write);
  }

  close() { if (!this.closed) { this.closed = true; this.#database?.close(); } }

  #row(scope, id) {
    const row = this.database.prepare('SELECT * FROM jefa_work_items WHERE space_id = ? AND project_id = ? AND id = ?')
      .get(scope.spaceId, scope.projectId, id);
    if (!row) throw new EmployeeError('Task not found in this project', 404, 'task_not_found');
    return row;
  }

  #projectRevision(scope) {
    return this.database.prepare('SELECT revision FROM jefa_projects WHERE space_id = ? AND project_id = ?')
      .get(scope.spaceId, scope.projectId)?.revision ?? 0;
  }

  // share: { slug, enabledAt } to change sharing; omitted keeps it.
  #bumpProject(scope, share) {
    const current = this.database.prepare('SELECT * FROM jefa_projects WHERE space_id = ? AND project_id = ?')
      .get(scope.spaceId, scope.projectId);
    this.database.prepare(`INSERT INTO jefa_projects(space_id, project_id, revision, share_slug, share_enabled_at)
        VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(space_id, project_id) DO UPDATE SET revision = excluded.revision,
        share_slug = excluded.share_slug, share_enabled_at = excluded.share_enabled_at`)
      .run(scope.spaceId, scope.projectId, (current?.revision ?? 0) + 1,
        share ? share.slug : current?.share_slug ?? null, share ? share.enabledAt : current?.share_enabled_at ?? null);
  }

  // Returns the task as stored.
  #write(scope, item, revision, actor) {
    this.database.prepare(`INSERT INTO jefa_work_items(space_id, project_id, id, revision, title, summary, status, priority,
        visibility, work_type, acceptance_criteria, tags, accepted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_id, project_id, id) DO UPDATE SET revision = excluded.revision, title = excluded.title,
        summary = excluded.summary, status = excluded.status, priority = excluded.priority, visibility = excluded.visibility,
        work_type = excluded.work_type, acceptance_criteria = excluded.acceptance_criteria, tags = excluded.tags,
        accepted_at = excluded.accepted_at, updated_at = excluded.updated_at`)
      .run(scope.spaceId, scope.projectId, item.id, revision, item.title, item.summary, item.status, item.priority,
        item.visibility, item.workType ?? null, JSON.stringify(item.acceptanceCriteria), JSON.stringify(item.tags),
        item.acceptedAt ?? null, item.createdAt, item.updatedAt);
    this.database.prepare(`INSERT INTO jefa_work_item_revisions(space_id, project_id, id, revision, actor, record, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(scope.spaceId, scope.projectId, item.id, revision, actor, JSON.stringify(item), item.updatedAt);
    this.#bumpProject(scope);
    return itemFromRow(this.#row(scope, item.id));
  }

  // updatedAt is the version a caller sends back, so each change moves it forward.
  #nextTime(previous) {
    const now = this.now().getTime();
    return new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();
  }

  // A retried request returns what it returned the first time; the same ID
  // with different content is refused instead of applied twice.
  #once(scope, kind, requestId, request, apply) {
    const digest = contentHash(request);
    return this.#transaction(() => {
      const stored = this.database.prepare(`SELECT digest, result FROM jefa_requests
        WHERE space_id = ? AND project_id = ? AND kind = ? AND request_id = ?`).get(scope.spaceId, scope.projectId, kind, requestId);
      if (stored) {
        if (stored.digest !== digest) {
          throw new EmployeeError('This request ID was already used for a different change', 409, 'request_conflict');
        }
        return JSON.parse(stored.result);
      }
      const result = apply();
      this.database.prepare(`INSERT INTO jefa_requests(space_id, project_id, kind, request_id, digest, result, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(scope.spaceId, scope.projectId, kind, requestId, digest, JSON.stringify(result), this.now().toISOString());
      return result;
    });
  }

  #transaction(apply) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = apply();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function itemFromRow(row) {
  return {
    id: row.id, projectId: row.project_id, title: row.title, summary: row.summary, status: row.status,
    priority: row.priority, visibility: row.visibility, ...(row.work_type ? { workType: row.work_type } : {}),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria), tags: JSON.parse(row.tags),
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}), createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function shareState(projectId, slug) {
  return { id: projectId, publicShareEnabled: Boolean(slug), ...(slug ? { publicShareSlug: slug } : {}), acceptsPublicRequests: false };
}

function sameText(expected, actual) {
  const left = Buffer.from(expected);
  const right = Buffer.from(String(actual));
  return left.length === right.length && timingSafeEqual(left, right);
}
