import { sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

const grantMigrations = [
  { id: 'runner-host/4-invitation-scopes', to: 4, kind: 'add-columns', table: 'invitations',
    summary: 'the personal space and scopes a one-use invitation grants',
    columns: { grant_space: 'TEXT', grant_scopes: 'TEXT' } },
  { id: 'runner-host/5-grant-pairing', to: 5, kind: 'add-columns', table: 'runners',
    summary: 'bind permissions to the personal space and current pairing',
    columns: { grant_space: 'TEXT', grant_pairing: 'TEXT' } },
  { id: 'runner-host/6-scope-grants', to: 6, kind: 'add-table', table: 'scope_grants',
    summary: 'follow requests and local decisions for each paired runner and scope',
    create: `CREATE TABLE scope_grants(
      space TEXT NOT NULL, fingerprint TEXT NOT NULL, pairing TEXT NOT NULL, scope TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','allowed','revoked')), version INTEGER NOT NULL,
      decided_at TEXT, PRIMARY KEY(space,fingerprint,pairing,scope));` }
];

const ownershipMigrations = [
  { id: 'runner-host/7-project-owners', to: 7, kind: 'add-table', table: 'project_owners',
    summary: 'one persistent owner or reservation per project in a personal space',
    create: `CREATE TABLE project_owners(space TEXT NOT NULL, project TEXT NOT NULL, owner TEXT NOT NULL,
      generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','owned','conflict')),
      operation TEXT NOT NULL, verified_at TEXT, PRIMARY KEY(space,project));` },
  { id: 'runner-host/8-owner-inventory', to: 8, kind: 'add-table', table: 'owner_inventory',
    summary: 'which computers have completed their first ownership inventory',
    create: `CREATE TABLE owner_inventory(space TEXT NOT NULL, fingerprint TEXT NOT NULL,
      checked_at TEXT, PRIMARY KEY(space,fingerprint));` },
  { id: 'runner-host/9-project-claims', to: 9, kind: 'add-table', table: 'project_claims',
    summary: 'retain each computer’s project claim independently through conflicts and disconnections',
    create: `CREATE TABLE project_claims(space TEXT NOT NULL, project TEXT NOT NULL, fingerprint TEXT NOT NULL,
      verified_at TEXT, PRIMARY KEY(space,project,fingerprint));` },
  { id: 'runner-host/10-owner-moves', to: 10, kind: 'add-table', table: 'owner_moves',
    summary: 'durable owner change decisions, each bound to the source generation',
    create: `CREATE TABLE owner_moves(space TEXT NOT NULL, project TEXT NOT NULL, move_id TEXT NOT NULL,
      source TEXT NOT NULL, target TEXT NOT NULL, generation INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('preparing','aborted','committed')),
      PRIMARY KEY(space,project,move_id));
      CREATE UNIQUE INDEX owner_moves_preparing ON owner_moves(space,project) WHERE decision='preparing';` },
  { id: 'runner-host/11-project-permits', to: 11, kind: 'add-table', table: 'project_permits',
    summary: 'authenticated local project creation receipts from the paired authority',
    create: `CREATE TABLE project_permits(authority TEXT NOT NULL, space TEXT NOT NULL, project TEXT NOT NULL,
      owner TEXT NOT NULL, generation INTEGER NOT NULL, operation TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','owned','revoked')), PRIMARY KEY(authority,space,project));` },
  { id: 'runner-host/12-retired-inventory', to: 12, kind: 'add-columns', table: 'owner_inventory',
    summary: 'a local decision to retire a revoked device while retaining all known project claims',
    columns: { retired_at: 'TEXT' } }
];

export const RUNNER_HOST_FORMAT = sqliteFormat({
  store: 'runner-host',
  schema: `
    CREATE TABLE IF NOT EXISTS runners(
      fingerprint TEXT PRIMARY KEY, name TEXT NOT NULL, paired_at TEXT NOT NULL,
      last_seen_at TEXT, last_address TEXT, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS invitations(
      code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_by TEXT);
    CREATE TABLE IF NOT EXISTS replays(
      id TEXT PRIMARY KEY, runner TEXT NOT NULL, tool TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS replays_at ON replays(at);`,
  // Version 1 is what 0.29.0-beta.1 shipped; every beta.1 host has it.
  migrations: [{
    id: 'runner-host/2-runner-device-name', to: 2, kind: 'add-columns', table: 'runners',
    summary: 'the name each runner gives itself, shown beside the name the person typed at its invitation',
    columns: { device_name: 'TEXT' }
  }, {
    // An id is a runner's own (key runner, id), held pending while it is applied.
    id: 'runner-host/3-replays-per-runner', to: 3, kind: 'replace-table', table: 'replays',
    summary: 'checkpoint ids kept per runner and held while applied; the replays table is made again and the '
      + 'beta.1 replay records are not kept',
    discardsRows: 'a replay record only answers a runner that delivers the same entry again; an entry still waiting '
      + 'is delivered again and applied once more at most, which beta.1 already allowed',
    create: `CREATE TABLE replays(
      runner TEXT NOT NULL, id TEXT NOT NULL, tool TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'done')), at TEXT NOT NULL, result TEXT, holder TEXT,
      PRIMARY KEY(runner, id));
    CREATE INDEX IF NOT EXISTS replays_at ON replays(at);`
  }, ...grantMigrations, ...ownershipMigrations]
});
