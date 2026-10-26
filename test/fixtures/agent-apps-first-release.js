import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The Agent app registry as its first release (rec#7 part 1) left it: no
// version, no ledger, an approval with presence only.
export const AGENT_APPS_FIRST_RELEASE = `CREATE TABLE agent_apps (app_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
      personal_space_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      active_version TEXT, data_format INTEGER, deletion_ticket TEXT, deletion_expires_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT);
    CREATE TABLE agent_app_versions (app_id TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL,
      manifest TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, submitted_at TEXT NOT NULL,
      PRIMARY KEY (app_id, version));
    CREATE TABLE agent_app_approvals (app_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, permissions TEXT NOT NULL,
      data TEXT NOT NULL, resident INTEGER NOT NULL, approved_by TEXT NOT NULL,
      entrypoint TEXT NOT NULL CHECK (entrypoint IN ('cli', 'http')),
      presence TEXT NOT NULL CHECK (presence IN ('unverified', 'hello', 'touchid', 'polkit')),
      approved_at TEXT NOT NULL, PRIMARY KEY (app_id, version));
    CREATE TABLE agent_app_tokens (token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
      permissions TEXT NOT NULL, issued_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT);
    CREATE TABLE agent_app_events (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, at TEXT NOT NULL,
      action TEXT NOT NULL, version TEXT, actor TEXT, detail TEXT);`;

// Synthetic app IDs: the identity-key backfill (agent-apps/7-identity-keys)
// names each by its ID, and every one waits for a person's confirmation.
export const FIRST_RELEASE_APP_IDS = Object.freeze(['app-00000000000000000000000000000001',
  'app-00000000000000000000000000000002']);

// A first-release registry at path with the synthetic apps; their names are
// sentinel content no preview, log or receipt may show.
export function writeFirstReleaseAgentApps(path, appIds = FIRST_RELEASE_APP_IDS) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec(AGENT_APPS_FIRST_RELEASE);
    const insert = database.prepare(`INSERT INTO agent_apps(app_id, provider, personal_space_id, agent_id, name, status,
      created_at, updated_at) VALUES(?, 'http://127.0.0.1:1', 'space', 'agent', ?, 'active', ?, ?)`);
    appIds.forEach((appId, index) => insert.run(appId, `sentinel app name ${index + 1}`,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'));
  } finally { database.close(); }
}
