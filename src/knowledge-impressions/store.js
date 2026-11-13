import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// rec#63 direction A: which knowledge items the automatic task-entry recall
// showed an Agent, and which of them the Agent later reported using. Step 2
// reads the per-item counts (usage) as a bounded ranking prior
// (ranking-prior.js); it reorders the recall, never removes an item from it.
// No item text, names or summaries are stored: ids, rank,
// score and confirmation status only. task_key is a SHA-256 hex of the task
// context token, so the token itself is never stored.
// task_deliveries (version 2): per task, the client it entered from and which
// of the person's effective preferences FULI delivered with its entry, as
// "kind:id" keys, so the compounding statement can count what was carried
// into tasks. Tasks before version 2 have recall rows only.
const TASK_DELIVERIES = `
  CREATE TABLE IF NOT EXISTS task_deliveries(
    task_key TEXT PRIMARY KEY,
    personal_space_id TEXT NOT NULL,
    source_application TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    preference_keys TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS task_deliveries_at ON task_deliveries(delivered_at);
  CREATE INDEX IF NOT EXISTS recall_impressions_shown_at ON recall_impressions(shown_at);`;

export const RECALL_IMPRESSIONS_FORMAT = sqliteFormat({
  store: 'recall-impressions',
  schema: `
    CREATE TABLE IF NOT EXISTS recall_impressions(
      task_key TEXT NOT NULL,
      personal_space_id TEXT NOT NULL,
      personal_project_id TEXT,
      item_kind TEXT NOT NULL CHECK(item_kind IN ('entity','relationship')),
      item_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      score REAL,
      confirmation_status TEXT,
      shown_at TEXT NOT NULL,
      use_kind TEXT CHECK(use_kind IN ('cited','applied')),
      used_at TEXT,
      PRIMARY KEY(task_key, item_kind, item_id));`,
  migrations: [{
    id: 'recall-impressions/2-task-deliveries', to: 2, kind: 'add-table', table: 'task_deliveries',
    summary: 'per task, its client and the preferences its entry delivered, and a time index for the retention cut',
    create: TASK_DELIVERIES
  }]
});

// Rows older than this are deleted on the next write.
const RETENTION_DAYS = 180;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
// What the statement counts as carried in [from, to): recall rows and task
// entries of one space; bound with (personalSpaceId, from, to).
const RECALL_IN_WINDOW = 'FROM recall_impressions WHERE personal_space_id = ? AND shown_at >= ? AND shown_at < ?';
const ENTRIES_IN_WINDOW = 'FROM task_deliveries WHERE personal_space_id = ? AND delivered_at >= ? AND delivered_at < ?';
// A task entry's preference list is bounded by the Provider; this caps what one row keeps.
const MAX_DELIVERED_PREFERENCES = 100;

export class RecallImpressionsStore {
  constructor(path = ':memory:', now = () => new Date()) {
    this.path = path;
    this.now = now;
  }

  // Opened on the first write; a missing file reads as empty and is never created by a read.
  get db() {
    this.database ??= openFormattedDatabase(this.path, RECALL_IMPRESSIONS_FORMAT);
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  transaction(work) {
    return immediateTransaction(this.db, work);
  }

  // What a task entry delivered: the recalled facts (relationships) and
  // entities, rank being the 1-based position within each kind, and the
  // effective preferences ({ id, item_kind }). One transaction; a second call
  // for the same task does not duplicate rows. An entry that delivered
  // nothing records nothing and never opens the store.
  recordDelivered({ taskContextToken, personalSpaceId, personalProjectId, sourceApplication, facts, entities, preferences }) {
    const rows = [
      ...(facts ?? []).map((item, index) => ({ kind: 'relationship', item, rank: index + 1 })),
      ...(entities ?? []).map((item, index) => ({ kind: 'entity', item, rank: index + 1 }))
    ];
    const preferenceKeys = [...new Set((preferences ?? []).filter(item => item?.id)
      .map(item => `${item.item_kind ?? 'entity'}:${item.id}`))].slice(0, MAX_DELIVERED_PREFERENCES);
    if (!rows.length && !preferenceKeys.length) return;
    const taskKey = taskKeyFor(taskContextToken);
    const now = this.now();
    const deliveredAt = now.toISOString();
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM recall_impressions WHERE shown_at < ?').run(cutoff);
      this.db.prepare('DELETE FROM task_deliveries WHERE delivered_at < ?').run(cutoff);
      const insert = this.db.prepare(`INSERT INTO recall_impressions
        (task_key, personal_space_id, personal_project_id, item_kind, item_id, rank, score, confirmation_status, shown_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_key, item_kind, item_id) DO NOTHING`);
      for (const { kind, item, rank } of rows) {
        insert.run(taskKey, personalSpaceId, personalProjectId ?? null, kind, item.id, rank,
          item.score ?? null, item.confirmation_status ?? null, deliveredAt);
      }
      this.db.prepare(`INSERT INTO task_deliveries(task_key, personal_space_id, source_application, delivered_at, preference_keys)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_key) DO NOTHING`)
        .run(taskKey, personalSpaceId, sourceApplication ?? 'other', deliveredAt, JSON.stringify(preferenceKeys));
    });
  }

  // What task entries carried in [from, to): distinct tasks that received
  // recalled knowledge or preferences, their distinct clients and the
  // distinct items. A task before version 2 counts by its recall alone and
  // names no client. ISO instants as toISOString() writes them.
  deliveredBetween({ personalSpaceId, from, to }) {
    if (!this.readable) return { tasks: 0, clients: 0, items: 0 };
    const window = [personalSpaceId, from, to];
    const count = sql => this.db.prepare(sql).get(...window, ...window).count;
    return {
      tasks: count(`SELECT COUNT(*) AS count FROM (SELECT task_key ${RECALL_IN_WINDOW} UNION SELECT task_key ${ENTRIES_IN_WINDOW})`),
      clients: this.db.prepare(`SELECT COUNT(DISTINCT source_application) AS count ${ENTRIES_IN_WINDOW}`).get(...window).count,
      items: count(`SELECT COUNT(*) AS count FROM (SELECT item_kind || ':' || item_id ${RECALL_IN_WINDOW}
        UNION SELECT key.value FROM task_deliveries, json_each(task_deliveries.preference_keys) AS key
        WHERE personal_space_id = ? AND delivered_at >= ? AND delivered_at < ?)`)
    };
  }

  // deliveredBetween's tasks per local day: the day is the stored UTC instant
  // moved by offsetMinutes (the caller's UTC offset), as YYYY-MM-DD. One
  // grouped read; days without a task are not listed.
  deliveredTasksByDay({ personalSpaceId, from, to, offsetMinutes }) {
    if (!this.readable) return [];
    const shift = `${offsetMinutes >= 0 ? '+' : '-'}${Math.abs(offsetMinutes)} minutes`;
    const window = [personalSpaceId, from, to];
    return this.db.prepare(`SELECT day, COUNT(*) AS tasks FROM (
        SELECT task_key, date(shown_at, ?) AS day ${RECALL_IN_WINDOW}
        UNION SELECT task_key, date(delivered_at, ?) AS day ${ENTRIES_IN_WINDOW})
      GROUP BY day ORDER BY day`).all(shift, ...window, shift, ...window)
      .map(({ day, tasks }) => ({ day, tasks }));
  }

  // Only updates rows that exist: an item used but never shown is ignored, and a
  // store nothing was ever shown in is not created.
  markUsed({ taskContextToken, items }) {
    if (!items?.length || !this.readable) return;
    const taskKey = taskKeyFor(taskContextToken);
    const usedAt = this.now().toISOString();
    this.transaction(() => {
      const update = this.db.prepare('UPDATE recall_impressions SET use_kind = ?, used_at = ? '
        + 'WHERE task_key = ? AND item_kind = ? AND item_id = ?');
      for (const item of items) {
        update.run(item.useKind, usedAt, taskKey, item.itemKind, item.itemId);
      }
    });
  }

  // Per item id, how many distinct reporting tasks were shown it and how many
  // of those used it, within one personal space. Only items with such a row appear; a store
  // nothing was ever shown in reads as empty and is not created.
  usage({ personalSpaceId, items }) {
    const usage = new Map();
    const wanted = new Set((items ?? []).filter(item => item?.itemId).map(item => `${item.itemKind}:${item.itemId}`));
    if (!wanted.size || !this.readable) return usage;
    const ids = [...new Set([...wanted].map(key => key.slice(key.indexOf(':') + 1)))];
    // Only a task that reported using something tells "shown, not used"
    // apart from "never reports use" (a client may never send knowledgeUsage),
    // so other tasks count for nothing. One grouped read; the 180-day
    // retention keeps the table small.
    const rows = this.db.prepare('SELECT item_kind, item_id, COUNT(*) AS shown, COUNT(use_kind) AS used '
      + `FROM recall_impressions WHERE personal_space_id = ? AND item_id IN (${ids.map(() => '?').join(', ')}) `
      + 'AND task_key IN (SELECT task_key FROM recall_impressions WHERE use_kind IS NOT NULL) '
      + 'GROUP BY item_kind, item_id').all(personalSpaceId, ...ids);
    for (const { item_kind: itemKind, item_id: itemId, shown, used } of rows) {
      if (wanted.has(`${itemKind}:${itemId}`)) usage.set(itemId, { shown, used });
    }
    return usage;
  }

  // Per item id, the hashed task contexts that reported applying it: what a
  // verification state joins with those tasks' judged acceptances.
  appliedTaskKeys({ personalSpaceId, itemIds }) {
    const keys = new Map();
    const ids = [...new Set((itemIds ?? []).filter(Boolean))];
    if (!ids.length || !this.readable) return keys;
    const rows = this.db.prepare('SELECT item_id, task_key FROM recall_impressions WHERE personal_space_id = ? '
      + `AND use_kind = 'applied' AND item_id IN (${ids.map(() => '?').join(', ')})`).all(personalSpaceId, ...ids);
    for (const { item_id: itemId, task_key: taskKey } of rows) keys.set(itemId, [...(keys.get(itemId) ?? []), taskKey]);
    return keys;
  }

  summary({ personalSpaceId, personalProjectId = null }) {
    if (!this.readable) return { tasks: 0, shown: 0, used: 0, byRank: [] };
    const rows = personalProjectId
      ? this.db.prepare('SELECT task_key, rank, use_kind FROM recall_impressions '
        + 'WHERE personal_space_id = ? AND personal_project_id = ?').all(personalSpaceId, personalProjectId)
      : this.db.prepare('SELECT task_key, rank, use_kind FROM recall_impressions '
        + 'WHERE personal_space_id = ?').all(personalSpaceId);
    const tasks = new Set();
    const byRank = new Map();
    let used = 0;
    for (const row of rows) {
      tasks.add(row.task_key);
      if (row.use_kind !== null) used += 1;
      const entry = byRank.get(row.rank) ?? { rank: row.rank, shown: 0, used: 0 };
      entry.shown += 1;
      if (row.use_kind !== null) entry.used += 1;
      byRank.set(row.rank, entry);
    }
    return { tasks: tasks.size, shown: rows.length, used,
      byRank: [...byRank.values()].sort((left, right) => left.rank - right.rank) };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

// What a judged acceptance records too, so a verification state joins its
// task context to the items used there without keeping the token.
export function taskKeyFor(taskContextToken) {
  return createHash('sha256').update(taskContextToken).digest('hex');
}
