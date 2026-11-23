import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Which parts of the person's FULI this computer reads and writes on another
// one (docs/runner-roles-design.md §3). A scope is `global`, `default`, or
// `project:<id>`; its owner is this computer (`local`) or a paired host
// (`host:<fingerprint>`). Everything without a route of its own follows
// `default`, and `default` is `local` unless a route says otherwise, so a
// computer with no routes is a plain FULI exactly as before.
//
// **One writer per scope.** A read-only copy of a scope another computer owns
// may also be kept here, with the time it was last brought up to date; the
// columns are here so that copy needs no format change when it arrives
// (step 3). Nothing writes them yet, and `fuli routes list` shows them when
// they are set.
export const ROUTES_FILE = 'runner/routes.sqlite';
export const GLOBAL_SCOPE = 'global';
export const DEFAULT_SCOPE = 'default';
export const LOCAL_OWNER = 'local';
const PROJECT_PREFIX = 'project:';
const HOST_PREFIX = 'host:';

export const ROUTES_FORMAT = sqliteFormat({
  store: 'runner-routes',
  schema: `
    CREATE TABLE IF NOT EXISTS routes(
      scope TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      replica INTEGER NOT NULL DEFAULT 0,
      replica_synced_at TEXT,
      updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_owners(
      token TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      at TEXT NOT NULL);`,
  migrations: []
});

// `host:<fingerprint>`, the owner written for a paired host.
export function hostOwner(fingerprint) {
  return `${HOST_PREFIX}${String(fingerprint).toLowerCase()}`;
}

// The fingerprint of a `host:…` owner, or null for `local`.
export function ownerFingerprint(owner) {
  return typeof owner === 'string' && owner.startsWith(HOST_PREFIX) ? owner.slice(HOST_PREFIX.length) : null;
}

// A scope name as the CLI and the router write it, or null when it is not one.
export function scopeName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === GLOBAL_SCOPE || text === DEFAULT_SCOPE) return text;
  if (!text.startsWith(PROJECT_PREFIX)) return null;
  const id = text.slice(PROJECT_PREFIX.length).trim();
  return id && id.length <= 400 && !/[\u0000-\u001f]/.test(id) ? `${PROJECT_PREFIX}${id}` : null;
}

export class RoutesStore {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    this.path = path;
    this.now = now;
    this.closed = false;
  }

  get db() {
    if (this.closed) throw new Error('The routes store is closed');
    this.database ??= openFormattedDatabase(this.path, ROUTES_FORMAT);
    return this.database;
  }

  // Every route, `global` and `default` first, then the projects by name.
  all() {
    if (this.#missing()) return [];
    return this.db.prepare('SELECT * FROM routes ORDER BY scope').all()
      .map((row) => ({ scope: row.scope, owner: row.owner, replica: row.replica === 1,
        replicaSyncedAt: row.replica_synced_at ?? null, updatedAt: row.updated_at }))
      .sort((one, other) => order(one.scope) - order(other.scope) || one.scope.localeCompare(other.scope));
  }

  // The owner of this scope: its own route, else `default`'s, else this computer.
  owner(scope) {
    if (this.#missing()) return LOCAL_OWNER;
    const row = this.db.prepare('SELECT owner FROM routes WHERE scope = ?').get(scope)
      ?? (scope === DEFAULT_SCOPE ? null : this.db.prepare('SELECT owner FROM routes WHERE scope = ?').get(DEFAULT_SCOPE));
    return row?.owner ?? LOCAL_OWNER;
  }

  // Whether anything at all is routed to another computer: what decides
  // whether this computer loads the follower's modules at all.
  followsAnything() {
    if (this.#missing()) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM routes WHERE owner <> ? LIMIT 1`).get(LOCAL_OWNER));
  }

  // Sets one scope's owner. `local` takes a scope back to this computer.
  set(scope, owner) {
    this.db.prepare(`INSERT INTO routes(scope, owner, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET owner = excluded.owner, updated_at = excluded.updated_at`)
      .run(scope, owner, new Date(this.now()).toISOString());
  }

  // What `fuli runner join` writes, and what a data directory that was a runner
  // before this version becomes (docs/runner-roles-design.md §10): everything
  // follows the host. Written once; a route the person changed later stays.
  followEverything(owner) {
    return immediateTransaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM routes LIMIT 1').get()) return false;
      for (const scope of [GLOBAL_SCOPE, DEFAULT_SCOPE]) this.set(scope, owner);
      return true;
    });
  }

  // Which computer entered this task. A task token is the owner's, and the
  // checkpoint of that task goes back to the computer that entered it, whatever
  // the routes became meanwhile (docs/runner-roles-design.md §4). Kept until
  // the pairing ends, as everything a follower keeps is.
  rememberTaskOwner(token, owner) {
    if (typeof token !== 'string' || !token) return;
    this.db.prepare(`INSERT INTO task_owners(token, owner, at) VALUES(?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET owner = excluded.owner, at = excluded.at`)
      .run(token, owner, new Date(this.now()).toISOString());
  }

  // The owner of a task token, or null when this computer never saw it entered.
  taskOwner(token) {
    if (this.#missing() || typeof token !== 'string' || !token) return null;
    return this.db.prepare('SELECT owner FROM task_owners WHERE token = ?').get(token)?.owner ?? null;
  }

  // `fuli runner join`: 「follow everything」 on the host just joined. `global`
  // and `default` go to it, and so does every scope that followed another
  // host, which this computer can no longer reach; a scope this computer owns
  // stays its own.
  joined(owner) {
    immediateTransaction(this.db, () => {
      this.db.prepare(`UPDATE routes SET owner = ?, updated_at = ? WHERE owner <> ?`)
        .run(owner, new Date(this.now()).toISOString(), LOCAL_OWNER);
      for (const scope of [GLOBAL_SCOPE, DEFAULT_SCOPE]) this.set(scope, owner);
    });
  }

  #missing() {
    return !this.database && this.path !== ':memory:' && !existsSync(this.path);
  }

  close() {
    this.closed = true;
    this.database?.close();
    this.database = null;
  }
}

function order(scope) {
  return scope === GLOBAL_SCOPE ? 0 : scope === DEFAULT_SCOPE ? 1 : 2;
}
