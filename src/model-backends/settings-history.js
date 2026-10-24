import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { configRevision } from './config.js';

// What changed in the built-in Agents' model settings, and when (rec#11
// D-42). model-backends.json and model-trust.sqlite hold only what is set
// now; this store keeps one immutable row per change saved from the console,
// never pruned. A settings row diffs the saved role's settings and its
// connection between the configuration before and after the save; its
// revisions are those configurations' revisions (config.js configRevision).
// A trust row is a 「只给建议」 switch or a warning acknowledgement; its
// revisions are the trust row's revisions. A key reference is recorded only
// as changed, never by its value; keys never pass here.
//
// A row is appended after its change was written, under that change's lock.
// When the append fails the change stands and the save answers not_recorded;
// a change that changes nothing records nothing. The configuration file can
// also change outside the console: a read then starts with a marker that
// changes are missing (revisions are of the whole file, so the newest row of
// any role is compared), and a configured role without any recorded save
// ends with one that its earlier changes were not recorded.

export const MODEL_SETTINGS_HISTORY_FORMAT = sqliteFormat({
  store: 'model-settings-history',
  schema: `
      CREATE TABLE IF NOT EXISTS settings_changes(
        change_id TEXT PRIMARY KEY, changed_at TEXT NOT NULL, role TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('settings', 'suggestions_only', 'warning_acknowledged')),
        from_revision TEXT, to_revision TEXT NOT NULL, changes TEXT NOT NULL);
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

// readConfig: the current model-backends.json as config.js reads it.
export function createModelSettingsHistory({
  path = ':memory:', readConfig, now = () => new Date(), warn = message => process.stderr.write(`${message}\n`)
}) {
  let database = null;
  // Opened on first change; a read of a missing file creates nothing.
  const open = () => (database ??= openFormattedDatabase(path, MODEL_SETTINGS_HISTORY_FORMAT));
  const readable = () => database || path === ':memory:' || existsSync(path);

  // 'recorded', 'unchanged', or 'not_recorded' when the store could not take
  // the row: the change itself is already saved and stays.
  function record(role, kind, fromRevision, toRevision, changes) {
    if (!changes.length) return 'unchanged';
    try {
      open().prepare('INSERT INTO settings_changes VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), now().toISOString(), role, kind, fromRevision, toRevision, JSON.stringify(changes));
      return 'recorded';
    } catch (error) {
      warn(`The ${kind} change of ${role} was saved, but its change history was not recorded: ${error?.message ?? error}`);
      return 'not_recorded';
    }
  }

  function rows(role, limit) {
    if (!readable()) return { rows: [], newestSettings: null, roleHasSettings: false };
    const db = open();
    return {
      rows: db.prepare('SELECT * FROM settings_changes WHERE (?1 IS NULL OR role = ?1) ORDER BY rowid DESC LIMIT ?2').all(role, limit),
      newestSettings: db.prepare('SELECT to_revision FROM settings_changes WHERE kind = \'settings\' ORDER BY rowid DESC LIMIT 1').get() ?? null,
      roleHasSettings: Boolean(db.prepare('SELECT 1 FROM settings_changes WHERE kind = \'settings\' AND (?1 IS NULL OR role = ?1) LIMIT 1').get(role))
    };
  }

  return {
    // before: the configuration as config.js read it before the save; after: the configuration written.
    recordSettings(role, before, after) {
      const previous = before.state === 'ok' ? before.config : null;
      return record(role, 'settings', configRevision(before), configRevision({ state: 'ok', config: after }),
        settingsChanges(role, previous, after));
    },
    // A trust change from one row revision to the next; field names the changed column.
    recordTrust(role, kind, fromRevision, { field, before, after }) {
      return record(role, kind, String(fromRevision), String(fromRevision + 1), before === after ? [] : [{ field, before, after }]);
    },
    // Newest first, with the markers of changes that are not recorded. role null reads every role.
    list({ role = null, limit = LIST_LIMIT } = {}) {
      const stored = rows(role, Math.min(limit, MAX_LIST_LIMIT));
      const loaded = readConfig();
      const entries = stored.rows.map(row => ({ changeId: row.change_id, changedAt: row.changed_at, role: row.role, kind: row.kind,
        fromRevision: row.from_revision, toRevision: row.to_revision, changes: JSON.parse(row.changes) }));
      if (stored.newestSettings && stored.newestSettings.to_revision !== configRevision(loaded)) {
        entries.unshift({ kind: 'changed_outside_console', changedAt: null, role });
      }
      const configured = loaded.state === 'ok' && (role ? Object.hasOwn(loaded.config.roles, role) : Object.keys(loaded.config.roles).length > 0);
      if (configured && !stored.roleHasSettings) entries.push({ kind: 'earlier_changes_not_recorded', changedAt: null, role });
      return entries;
    },
    close() { database?.close(); database = null; }
  };
}

// The saved role's settings, the connection it names, and that connection's
// fields, as { field, before, after } with dotted paths.
function settingsChanges(role, before, after) {
  const { connection: beforeId = null, ...beforeSettings } = before?.roles[role] ?? {};
  const { connection: afterId, ...afterSettings } = after.roles[role];
  const changes = [];
  diff('settings', before?.roles[role] ? beforeSettings : null, afterSettings, changes);
  if (beforeId !== afterId) changes.push({ field: 'connection', before: beforeId, after: afterId });
  diff('connection', beforeId ? before.connections[beforeId] : null, after.connections[afterId], changes);
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
