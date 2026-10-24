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
// are listed by the time of their change; at the same time, trust rows of
// one role by revision and settings rows in the order they were saved.
//
// Records form chains: the saves, each starting from the revision the one
// before it left (revisions are of the whole file, so across roles), and
// each role's trust rows. A marker that some changes were not recorded,
// naming no cause, sits wherever a chain breaks, and on top when the current
// file or a role's trust revision is past the latest record. A role
// configured before any save was recorded ends with one that its earlier
// changes were not recorded.

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

  // Every row in append order: settings rows are appended under the file's
  // lock, so their order is the order of the saves. A person's changes are
  // few, so the whole store is read and its chains checked here.
  const storedRows = () => (readable() ? open().prepare('SELECT rowid AS seq, * FROM settings_changes ORDER BY rowid').all() : []);

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
      const stored = storedRows();
      const loaded = readConfig();
      const roles = role ? [role] : MODEL_BACKEND_ROLES;
      const marker = { kind: 'unrecorded_changes', changedAt: null, role };
      const settings = settingsChain(stored);
      const trust = roles.map(each => trustChain(stored, each));
      const items = [...stored.filter(row => roles.includes(row.role)).map(rowItem),
        ...[settings, ...trust].flatMap(chain => chain.breaks).map(at => ({ ...at, entry: marker }))].sort(newestFirst);
      const entries = withinLimit(items, Math.min(limit, MAX_LIST_LIMIT));
      // The current state is newer than the latest record.
      const ahead = (settings.latest !== undefined && settings.latest !== configRevision(loaded))
        || roles.some((each, index) => readTrustRevision(each) > (trust[index].latest ?? 0));
      if (ahead) entries.unshift(marker);
      const configured = loaded.state === 'ok' && roles.some(each => Object.hasOwn(loaded.config.roles, each));
      if (configured && !stored.some(row => row.kind === 'settings' && roles.includes(row.role))) {
        entries.push({ kind: 'earlier_changes_not_recorded', changedAt: null, role });
      }
      return entries.filter((entry, index) => entry !== marker || entries[index - 1] !== marker);
    },
    close() { database?.close(); database = null; }
  };
}

// A row as a list item: its entry, and where it sorts.
function rowItem(row) {
  return { at: row.changed_at, seq: row.seq, role: row.role, revision: row.kind === 'settings' ? null : Number(row.to_revision),
    entry: { changeId: row.change_id, changedAt: row.changed_at, role: row.role, kind: row.kind, fromRevision: row.from_revision,
      toRevision: row.to_revision, changes: JSON.parse(row.changes), via: row.via } };
}

// The recorded saves in order (the rows of one save are appended together
// and share its time and revisions): the revision the latest one left, and
// where a save does not start from the revision the one before it left.
// The first save may start anywhere: what came before predates the store.
function settingsChain(stored) {
  const saves = [];
  for (const row of stored.filter(each => each.kind === 'settings')) {
    const last = saves.at(-1);
    if (last?.at === row.changed_at && last.from === row.from_revision && last.to === row.to_revision) continue;
    saves.push({ at: row.changed_at, seq: row.seq, from: row.from_revision, to: row.to_revision });
  }
  return { latest: saves.at(-1)?.to, breaks: saves.slice(1).filter((save, index) => save.from !== saves[index].to)
    .map(save => ({ at: save.at, seq: save.seq - 0.5, role: null, revision: null })) };
}

// The same for one role's trust rows, in revision order.
function trustChain(stored, role) {
  const rows = stored.filter(row => row.kind !== 'settings' && row.role === role)
    .sort((a, b) => Number(a.to_revision) - Number(b.to_revision));
  return { latest: rows.length ? Number(rows.at(-1).to_revision) : undefined,
    breaks: rows.slice(1).filter((row, index) => row.from_revision !== rows[index].to_revision)
      .map(row => ({ at: row.changed_at, seq: row.seq - 0.5, role, revision: Number(row.to_revision) - 0.5 })) };
}

// Newest change first; at the same time, one role's trust rows by revision
// and anything else in the order it was appended (settings saves in the
// order they were written). A break sorts right below the row after it.
function newestFirst(a, b) {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.revision !== null && b.revision !== null && a.role === b.role) return b.revision - a.revision;
  return b.seq - a.seq;
}

// The entries up to limit recorded changes, with the breaks among them.
function withinLimit(items, limit) {
  const entries = [];
  let changes = 0;
  for (const item of items) {
    if (item.entry.changedAt !== null && changes++ === limit) break;
    entries.push(item.entry);
  }
  return entries;
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
