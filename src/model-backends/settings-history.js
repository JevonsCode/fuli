import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { MODEL_BACKEND_ROLES, configRevision } from './config.js';

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
// answers not_recorded; a change that changes nothing records nothing. Rows
// are listed by the time of their change, and trust rows of one role at one
// time by revision, never in the order they were appended. A read starts
// with a marker that some changes were not recorded, without naming a cause,
// when the current file is not the one the newest settings row left
// (revisions are of the whole file, so the newest row of any role is
// compared) or a role's trust revision is past its newest trust row; a role
// configured, or with trust changes, before any of them was recorded ends
// with one that its earlier changes were not recorded.

export const MODEL_SETTINGS_HISTORY_FORMAT = sqliteFormat({
  store: 'model-settings-history',
  schema: `
      CREATE TABLE IF NOT EXISTS settings_changes(
        change_id TEXT PRIMARY KEY, changed_at TEXT NOT NULL, role TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('settings', 'suggestions_only', 'warning_acknowledged')),
        from_revision TEXT, to_revision TEXT NOT NULL, changes TEXT NOT NULL, via TEXT);
      CREATE INDEX IF NOT EXISTS settings_changes_role ON settings_changes(role);
      CREATE TRIGGER IF NOT EXISTS settings_changes_no_update BEFORE UPDATE ON settings_changes
        BEGIN SELECT RAISE(ABORT, 'model settings changes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS settings_changes_no_delete BEFORE DELETE ON settings_changes
        BEGIN SELECT RAISE(ABORT, 'model settings changes are immutable'); END;`
});
const LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
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
  // stands, and nothing here throws.
  function record(kind, rows, changedAt = now().toISOString()) {
    if (!rows.length) return 'unchanged';
    let db = null;
    try {
      db = open();
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare('INSERT INTO settings_changes VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) {
        insert.run(randomUUID(), changedAt, row.role, kind, row.fromRevision, row.toRevision, JSON.stringify(row.changes), row.via ?? null);
      }
      db.exec('COMMIT');
      return 'recorded';
    } catch (error) {
      if (db?.isTransaction) db.exec('ROLLBACK');
      warn(`The ${kind} change of ${rows.map(row => row.role).join(', ')} was saved, but its change history was not recorded: `
        + `${error?.message ?? error}`);
      return 'not_recorded';
    }
  }

  function rows(role, limit) {
    if (!readable()) return { rows: [], newestSettings: null, roleHasSettings: false, trustRevisions: new Map() };
    const db = open();
    return {
      rows: db.prepare(`SELECT * FROM settings_changes WHERE (?1 IS NULL OR role = ?1)
        ORDER BY changed_at DESC, CASE WHEN kind = 'settings' THEN NULL ELSE CAST(to_revision AS INTEGER) END DESC, role, change_id
        LIMIT ?2`).all(role, limit),
      newestSettings: db.prepare('SELECT to_revision FROM settings_changes WHERE kind = \'settings\' ORDER BY changed_at DESC LIMIT 1').get() ?? null,
      roleHasSettings: Boolean(db.prepare('SELECT 1 FROM settings_changes WHERE kind = \'settings\' AND (?1 IS NULL OR role = ?1) LIMIT 1').get(role)),
      trustRevisions: new Map(db.prepare(`SELECT role, MAX(CAST(to_revision AS INTEGER)) AS revision FROM settings_changes
        WHERE kind <> 'settings' GROUP BY role`).all().map(row => [row.role, row.revision]))
    };
  }

  // Whether the current settings or trust state is past what the newest rows recorded.
  function unrecorded(role, stored, loaded) {
    if (stored.newestSettings && stored.newestSettings.to_revision !== configRevision(loaded)) return true;
    return (role ? [role] : MODEL_BACKEND_ROLES).some(each => readTrustRevision(each) > (stored.trustRevisions.get(each) ?? 0));
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
        changes: [{ field, before, after }] }], changedAt);
    },
    // Newest first, with the markers of changes that are not recorded. role null reads every role.
    list({ role = null, limit = LIST_LIMIT } = {}) {
      const stored = rows(role, Math.min(limit, MAX_LIST_LIMIT));
      const loaded = readConfig();
      const entries = stored.rows.map(row => ({ changeId: row.change_id, changedAt: row.changed_at, role: row.role, kind: row.kind,
        fromRevision: row.from_revision, toRevision: row.to_revision, changes: JSON.parse(row.changes), via: row.via }));
      if (unrecorded(role, stored, loaded)) entries.unshift({ kind: 'unrecorded_changes', changedAt: null, role });
      const configured = loaded.state === 'ok' && (role ? Object.hasOwn(loaded.config.roles, role) : Object.keys(loaded.config.roles).length > 0);
      if (configured && !stored.roleHasSettings) entries.push({ kind: 'earlier_changes_not_recorded', changedAt: null, role });
      return entries;
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
