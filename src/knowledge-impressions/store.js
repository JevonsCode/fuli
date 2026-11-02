import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// rec#63 direction A, step 1: which knowledge items the automatic task-entry
// recall showed an Agent, and which of them the Agent later reported using, so
// ranking can later be learned from "shown but not used" vs "shown and used".
// Recording only: nothing reads this for ranking yet, and nothing changes what
// the Agent receives. No item text, names or summaries are stored: ids, rank,
// score and confirmation status only. task_key is a SHA-256 hex of the task
// context token, so the token itself is never stored.
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
      PRIMARY KEY(task_key, item_kind, item_id));`
});

// Rows older than this are deleted on the next write.
const RETENTION_DAYS = 180;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // facts are relationships, entities are entities; rank is the 1-based
  // position within each kind as delivered. A second call for the same task
  // does not duplicate rows. An empty recall records nothing and never opens
  // the store.
  recordShown({ taskContextToken, personalSpaceId, personalProjectId, facts, entities }) {
    const rows = [
      ...(facts ?? []).map((item, index) => ({ kind: 'relationship', item, rank: index + 1 })),
      ...(entities ?? []).map((item, index) => ({ kind: 'entity', item, rank: index + 1 }))
    ];
    if (!rows.length) return;
    const taskKey = taskKeyFor(taskContextToken);
    const now = this.now();
    const shownAt = now.toISOString();
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM recall_impressions WHERE shown_at < ?').run(cutoff);
      const insert = this.db.prepare(`INSERT INTO recall_impressions
        (task_key, personal_space_id, personal_project_id, item_kind, item_id, rank, score, confirmation_status, shown_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_key, item_kind, item_id) DO NOTHING`);
      for (const { kind, item, rank } of rows) {
        insert.run(taskKey, personalSpaceId, personalProjectId ?? null, kind, item.id, rank,
          item.score ?? null, item.confirmation_status ?? null, shownAt);
      }
    });
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

function taskKeyFor(taskContextToken) {
  return createHash('sha256').update(taskContextToken).digest('hex');
}
