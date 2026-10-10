import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// This device's side of the LAN roundtable: owner settings and shares, every
// receiving attempt (written before any process starts), the result outbox,
// and where messages this device sent were routed.
export function createNodeStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shares (
      binding_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      clients_json TEXT NOT NULL, working_directory TEXT, created_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS shares_active ON shares(space_id, project_id, agent_id) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS authorities (
      node_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, public_key TEXT NOT NULL, bound_by TEXT NOT NULL, bound_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      message_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL, binding_id TEXT,
      detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(message_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS outbox (
      message_id TEXT NOT NULL, attempt_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT, PRIMARY KEY(message_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS sent (
      message_id TEXT PRIMARY KEY, target_node TEXT NOT NULL, binding_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const now = () => new Date().toISOString();
  const transaction = (work) => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = work(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const shareKey = (share) => [share.spaceId, share.projectId, share.agentId].join('\u0000');
  const shareView = (row) => row && ({ bindingId: row.binding_id, spaceId: row.space_id, projectId: row.project_id, agentId: row.agent_id,
    clients: JSON.parse(row.clients_json), workingDirectory: row.working_directory ?? null, createdAt: row.created_at, revokedAt: row.revoked_at });

  return {
    setting(key) {
      const row = database.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
      return row ? JSON.parse(row.value_json) : null;
    },
    setSetting(key, value) {
      if (value === null) database.prepare('DELETE FROM settings WHERE key = ?').run(key);
      else database.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(value), now());
    },
    shares: () => database.prepare('SELECT * FROM shares WHERE revoked_at IS NULL ORDER BY created_at').all().map(shareView),
    share: (bindingId) => shareView(database.prepare('SELECT * FROM shares WHERE binding_id = ? AND revoked_at IS NULL').get(bindingId)),
    // Replaces the owner's share list; a removed share is kept as revoked history.
    replaceShares(shares, idFactory) {
      return transaction(() => {
        const at = now();
        const wanted = new Map(shares.map((share) => [shareKey(share), share]));
        for (const row of database.prepare('SELECT * FROM shares WHERE revoked_at IS NULL').all()) {
          const key = shareKey(shareView(row));
          const next = wanted.get(key);
          if (!next) database.prepare('UPDATE shares SET revoked_at = ? WHERE binding_id = ?').run(at, row.binding_id);
          else {
            database.prepare('UPDATE shares SET clients_json = ?, working_directory = ? WHERE binding_id = ?')
              .run(JSON.stringify(next.clients), next.workingDirectory ?? null, row.binding_id);
            wanted.delete(key);
          }
        }
        for (const share of wanted.values()) {
          database.prepare(`INSERT INTO shares(binding_id, space_id, project_id, agent_id, clients_json, working_directory, created_at)
            VALUES(?,?,?,?,?,?,?)`).run(idFactory(), share.spaceId, share.projectId, share.agentId, JSON.stringify(share.clients),
            share.workingDirectory ?? null, at);
        }
        return this.shares();
      });
    },
    authority(nodeId) {
      const row = database.prepare('SELECT * FROM authorities WHERE node_id = ?').get(nodeId);
      return row ? { keyId: row.key_id, publicKey: row.public_key, boundBy: row.bound_by, boundAt: row.bound_at } : null;
    },
    // A device's origin key is bound once. Only the local owner re-pairing a
    // device (forgetAuthority first) can bind a different key.
    bindAuthority(nodeId, { keyId, publicKey }, boundBy) {
      return transaction(() => {
        const existing = this.authority(nodeId);
        if (existing) return { bound: existing.keyId === keyId && existing.publicKey === publicKey, authority: existing };
        database.prepare('INSERT INTO authorities(node_id, key_id, public_key, bound_by, bound_at) VALUES(?,?,?,?,?)')
          .run(nodeId, keyId, publicKey, boundBy, now());
        return { bound: true, authority: this.authority(nodeId) };
      });
    },
    forgetAuthority: (nodeId) => database.prepare('DELETE FROM authorities WHERE node_id = ?').run(nodeId),
    forgetAuthorities: () => database.prepare('DELETE FROM authorities').run(),
    attemptsFor: (messageId) => database.prepare('SELECT * FROM attempts WHERE message_id = ? ORDER BY created_at').all(messageId),
    recordAttempt({ messageId, attemptId, bindingId }) {
      return transaction(() => {
        const existing = database.prepare('SELECT * FROM attempts WHERE message_id = ? AND attempt_id = ?').get(messageId, attemptId);
        if (existing) return { inserted: false, attempt: existing };
        const at = now();
        database.prepare(`INSERT INTO attempts(message_id, attempt_id, state, binding_id, created_at, updated_at)
          VALUES(?,?, 'claimed', ?,?,?)`).run(messageId, attemptId, bindingId ?? null, at, at);
        return { inserted: true, attempt: database.prepare('SELECT * FROM attempts WHERE message_id = ? AND attempt_id = ?').get(messageId, attemptId) };
      });
    },
    setAttemptState: (messageId, attemptId, state, detail = null) => database.prepare(
      'UPDATE attempts SET state = ?, detail = coalesce(?, detail), updated_at = ? WHERE message_id = ? AND attempt_id = ?')
      .run(state, detail, now(), messageId, attemptId),
    unfinishedAttempts: () => database.prepare(`SELECT a.* FROM attempts a WHERE a.state IN ('claimed','accepted','starting','running')
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.message_id = a.message_id AND o.attempt_id = a.attempt_id)`).all(),
    queueResult(messageId, attemptId, payload) {
      database.prepare(`INSERT INTO outbox(message_id, attempt_id, payload_json, created_at) VALUES(?,?,?,?)
        ON CONFLICT(message_id, attempt_id) DO NOTHING`).run(messageId, attemptId, JSON.stringify(payload), now());
    },
    pendingResults: () => database.prepare('SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY created_at').all()
      .map((row) => ({ messageId: row.message_id, attemptId: row.attempt_id, payload: JSON.parse(row.payload_json) })),
    markDelivered: (messageId, attemptId) => database.prepare(
      'UPDATE outbox SET delivered_at = ? WHERE message_id = ? AND attempt_id = ?').run(now(), messageId, attemptId),
    recordSent: ({ messageId, targetNode, bindingId }) => database.prepare(
      'INSERT OR IGNORE INTO sent(message_id, target_node, binding_id, created_at) VALUES(?,?,?,?)').run(messageId, targetNode, bindingId, now()),
    sent: (messageId) => database.prepare('SELECT * FROM sent WHERE message_id = ?').get(messageId) ?? null,
    close: () => database.close(),
  };
}
