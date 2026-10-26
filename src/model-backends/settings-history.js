import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { MODEL_BACKEND_ROLES, configRevision } from './config.js';
import { historyEntries } from './settings-history-list.js';

// What changed in the built-in Agents' model settings, and when (rec#11
// D-42). model-backends.json and model-trust.sqlite hold only what is set
// now; this store keeps one immutable row per change saved from the console,
// never pruned. A settings save diffs every role's effective settings (its
// own settings and the connection it names) between the configuration
// before and after the save, and records one row for each role that changed:
// roles that share the saved connection change with it, and their rows name
// the role whose settings were saved (via). Its revisions are those
// configurations' revisions (config.js configRevision). A trust row is a
// 「只给建议」 switch or a warning acknowledgement; its revisions are the
// trust row's revisions. A key reference is recorded only as changed, never
// by its value; keys never pass here.
//
// A settings row is appended after the file was written, under its lock; a
// trust row after its change committed, with the time and revision read in
// that change's transaction. When the append fails the change stands and
// answers not_recorded; nothing here throws. A change that changes nothing
// records nothing. The first record also keeps each role's trust revision
// at that moment (its baseline), so a read can tell trust changes made
// before recording began from changes whose record was lost. How the
// history reads, with its markers, is settings-history-list.js.

export const MODEL_SETTINGS_HISTORY_FORMAT = sqliteFormat({
  store: 'model-settings-history',
  schema: `
      CREATE TABLE IF NOT EXISTS settings_changes(
        change_id TEXT PRIMARY KEY, changed_at TEXT NOT NULL, role TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('settings', 'suggestions_only', 'warning_acknowledged')),
        from_revision TEXT, to_revision TEXT NOT NULL, changes TEXT NOT NULL, via TEXT);
      CREATE INDEX IF NOT EXISTS settings_changes_role ON settings_changes(role);
      CREATE TABLE IF NOT EXISTS trust_baselines(role TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS settings_changes_no_replace BEFORE INSERT ON settings_changes
        WHEN EXISTS (SELECT 1 FROM settings_changes WHERE change_id = NEW.change_id)
        BEGIN SELECT RAISE(ABORT, 'model settings changes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS settings_changes_no_update BEFORE UPDATE ON settings_changes
        BEGIN SELECT RAISE(ABORT, 'model settings changes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS settings_changes_no_delete BEFORE DELETE ON settings_changes
        BEGIN SELECT RAISE(ABORT, 'model settings changes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS trust_baselines_no_replace BEFORE INSERT ON trust_baselines
        WHEN EXISTS (SELECT 1 FROM trust_baselines WHERE role = NEW.role)
        BEGIN SELECT RAISE(ABORT, 'trust baselines are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS trust_baselines_no_update BEFORE UPDATE ON trust_baselines
        BEGIN SELECT RAISE(ABORT, 'trust baselines are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS trust_baselines_no_delete BEFORE DELETE ON trust_baselines
        BEGIN SELECT RAISE(ABORT, 'trust baselines are immutable'); END;`
});
const LIST_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;
// Recorded as changed only, without its value.
const REFERENCE_FIELDS = new Set(['connection.secretRef']);

// readConfig: the current model-backends.json as config.js reads it;
// readTrustRevision(role): the role's current trust row revision (role-trust.js).
export function createModelSettingsHistory({
  path = ':memory:', readConfig, readTrustRevision = () => 0, now = () => new Date(),
  warn = message => process.stderr.write(`${message}\n`)
}) {
  let database = null;
  // Opened on first change; a read of a missing file creates nothing.
  const open = () => (database ??= openFormattedDatabase(path, MODEL_SETTINGS_HISTORY_FORMAT));
  const readable = () => database || path === ':memory:' || existsSync(path);

  // Appends the rows of one change together. 'recorded', 'unchanged', or
  // 'not_recorded' when the store could not take them: the change itself
  // stands. committedTrust: the role and revision a trust change started
  // from, its baseline if this is the first record.
  function record(kind, rows, { changedAt = now().toISOString(), committedTrust = null } = {}) {
    if (!rows.length) return 'unchanged';
    let db = null;
    try {
      db = open();
      db.exec('BEGIN IMMEDIATE');
      if (!db.prepare('SELECT 1 FROM trust_baselines LIMIT 1').get()) {
        const baseline = db.prepare('INSERT INTO trust_baselines VALUES(?, ?)');
        for (const role of MODEL_BACKEND_ROLES) {
          baseline.run(role, role === committedTrust?.role ? committedTrust.revision : readTrustRevision(role));
        }
      }
      const insert = db.prepare('INSERT INTO settings_changes VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) {
        insert.run(randomUUID(), changedAt, row.role, kind, row.fromRevision, row.toRevision, JSON.stringify(row.changes), row.via ?? null);
      }
      db.exec('COMMIT');
      return 'recorded';
    } catch (error) {
      try {
        if (db?.isTransaction) db.exec('ROLLBACK');
        warn(`The ${kind} change of ${rows.map(row => row.role).join(', ')} was saved, but its change history was not recorded: `
          + `${error?.message ?? error}`);
      } catch {
        // The warning is a courtesy; the answer says not_recorded either way.
      }
      return 'not_recorded';
    }
  }

  // Every row in append order, and the baselines: settings rows are
  // appended under the file's lock, so their order is the order of the
  // saves. A person's changes are few, so the whole store is read.
  function stored() {
    if (!readable()) return { rows: [], baselines: new Map() };
    const db = open();
    return { rows: db.prepare('SELECT rowid AS seq, * FROM settings_changes ORDER BY rowid').all(),
      baselines: new Map(db.prepare('SELECT role, revision FROM trust_baselines').all().map(row => [row.role, row.revision])) };
  }

  return {
    // editedRole: the role whose settings were saved. before: the
    // configuration as config.js read it before the save; after: the configuration written.
    recordSettings(editedRole, before, after) {
      const previous = before.state === 'ok' ? before.config : null;
      const fromRevision = configRevision(before);
      const toRevision = configRevision({ state: 'ok', config: after });
      return record('settings', MODEL_BACKEND_ROLES
        .map(role => ({ role, fromRevision, toRevision, changes: settingsChanges(role, previous, after),
          via: role === editedRole ? null : editedRole }))
        .filter(row => row.changes.length));
    },
    // A committed trust change from one row revision to the next at changedAt; field names the changed column.
    recordTrust(role, kind, fromRevision, { field, before, after }, changedAt) {
      return record(kind, before === after ? [] : [{ role, fromRevision: String(fromRevision), toRevision: String(fromRevision + 1),
        changes: [{ field, before, after }] }], { changedAt, committedTrust: { role, revision: fromRevision } });
    },
    // Newest first, with the markers of changes that are not recorded. role
    // null reads every role. A role without a baseline began recording now.
    list({ role = null, limit = LIST_LIMIT } = {}) {
      const { rows, baselines } = stored();
      return historyEntries({ stored: rows, roles: role ? [role] : MODEL_BACKEND_ROLES, role, loaded: readConfig(),
        baseline: each => baselines.get(each) ?? readTrustRevision(each), limit: Math.min(limit, MAX_HISTORY_LIMIT), readTrustRevision });
    },
    close() { database?.close(); database = null; }
  };
}

// A role's effective settings: its own settings, the connection it names,
// and that connection's fields, as { field, before, after } with dotted
// paths. A role in neither configuration has none.
function settingsChanges(role, before, after) {
  const beforeRole = before?.roles[role] ?? null;
  const afterRole = after.roles[role] ?? null;
  if (!beforeRole && !afterRole) return [];
  const { connection: beforeId = null, ...beforeSettings } = beforeRole ?? {};
  const { connection: afterId = null, ...afterSettings } = afterRole ?? {};
  const changes = [];
  diff('settings', beforeRole ? beforeSettings : null, afterRole ? afterSettings : null, changes);
  if (beforeId !== afterId) changes.push({ field: 'connection', before: beforeId, after: afterId });
  diff('connection', beforeId ? before.connections[beforeId] : null, afterId ? after.connections[afterId] : null, changes);
  return changes;
}

// Objects are compared field by field (a missing side reads as null), any
// other value as a whole.
function diff(field, before, after, changes) {
  if (REFERENCE_FIELDS.has(field)) {
    if ((before ?? null) !== (after ?? null)) changes.push({ field, changed: true });
    return;
  }
  if ((isObject(before) || isObject(after)) && (isObject(before) || before == null) && (isObject(after) || after == null)) {
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      diff(`${field}.${key}`, before?.[key] ?? null, after?.[key] ?? null, changes);
    }
    return;
  }
  if (canonicalJson(before ?? null) !== canonicalJson(after ?? null)) changes.push({ field, before: before ?? null, after: after ?? null });
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
