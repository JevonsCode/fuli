import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Paired devices, one-use invitations and the cross-device message queue.
// Status changes are also appended to events, so history survives updates.
export function createCoordinatorStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, cert_pem TEXT NOT NULL, status TEXT NOT NULL,
      paired_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT, directory_json TEXT NOT NULL DEFAULT '[]',
      authority_json TEXT
    );
    CREATE TABLE IF NOT EXISTS invitations (
      code_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_at TEXT, used_by TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, sender_node TEXT NOT NULL, target_node TEXT NOT NULL, binding_id TEXT NOT NULL,
      assertion_json TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL,
      attempt_id TEXT, accepted_attempt TEXT, start_attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, reply TEXT, error TEXT, via TEXT, verified INTEGER,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_queue ON messages(target_node, status, created_at);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, node_id TEXT, kind TEXT NOT NULL,
      detail TEXT, at TEXT NOT NULL
    );
  `);
  const transaction = (work) => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = work(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const event = (at, { messageId = null, nodeId = null, kind, detail = null }) => database.prepare(
    'INSERT INTO events(message_id, node_id, kind, detail, at) VALUES(?,?,?,?,?)').run(messageId, nodeId, kind, detail, at);

  return {
    transaction,
    event,
    node: (id) => database.prepare('SELECT * FROM nodes WHERE id = ?').get(id) ?? null,
    nodes: () => database.prepare('SELECT * FROM nodes ORDER BY paired_at').all(),
    activeCertificates: () => database.prepare("SELECT cert_pem FROM nodes WHERE status = 'active'").all().map((row) => row.cert_pem),
    // Only pairing (a local owner action) records a device's origin authority.
    upsertNode({ id, name, certPem, authority = null, at }) {
      database.prepare(`INSERT INTO nodes(id, name, cert_pem, status, paired_at, authority_json) VALUES(?,?,?,'active',?,?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, cert_pem = excluded.cert_pem, status = 'active',
        revoked_at = NULL, directory_json = '[]', paired_at = excluded.paired_at, authority_json = excluded.authority_json`)
        .run(id, name, certPem, at, authority ? JSON.stringify(authority) : null);
      event(at, { nodeId: id, kind: 'paired' });
    },
    revokeNode(id, at) {
      database.prepare("UPDATE nodes SET status = 'revoked', revoked_at = ?, directory_json = '[]' WHERE id = ?").run(at, id);
      event(at, { nodeId: id, kind: 'revoked' });
    },
    touchNode: (id, at) => database.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(at, id),
    setDirectory: (id, entries) => database.prepare('UPDATE nodes SET directory_json = ? WHERE id = ?').run(JSON.stringify(entries), id),
    createInvitation: ({ codeHash, at, expiresAt }) => database.prepare(
      'INSERT INTO invitations(code_hash, created_at, expires_at) VALUES(?,?,?)').run(codeHash, at, expiresAt),
    invitation: (codeHash) => database.prepare('SELECT * FROM invitations WHERE code_hash = ?').get(codeHash) ?? null,
    openInvitations: (at) => database.prepare(
      'SELECT * FROM invitations WHERE used_at IS NULL AND expires_at > ?').all(at),
    useInvitation: (codeHash, nodeId, at) => database.prepare(
      'UPDATE invitations SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL').run(at, nodeId, codeHash).changes === 1,
    insertMessage(row) {
      database.prepare(`INSERT INTO messages(id, sender_node, target_node, binding_id, assertion_json, signature,
        status, expires_at, created_at, updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)`).run(
        row.id, row.senderNode, row.targetNode, row.bindingId, row.assertionJson, row.signature, row.expiresAt, row.at, row.at);
      event(row.at, { messageId: row.id, nodeId: row.senderNode, kind: 'queued' });
    },
    message: (id) => database.prepare('SELECT * FROM messages WHERE id = ?').get(id) ?? null,
    queuedCount: (targetNode) => database.prepare(
      "SELECT count(*) AS count FROM messages WHERE target_node = ? AND status IN ('queued','claimed','running')").get(targetNode).count,
    nextQueued: (targetNode, at) => database.prepare(`SELECT * FROM messages WHERE target_node = ? AND status = 'queued'
      AND expires_at > ? AND cancel_requested = 0 ORDER BY created_at LIMIT 1`).get(targetNode, at) ?? null,
    updateMessage(id, changes, at, kind, detail = null) {
      const columns = Object.keys(changes);
      database.prepare(`UPDATE messages SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...columns.map((column) => changes[column]), at, id);
      event(at, { messageId: id, kind, detail });
    },
    staleLeases: (at) => database.prepare(
      "SELECT * FROM messages WHERE status IN ('claimed','running') AND lease_expires_at <= ?").all(at),
    expiredQueued: (at) => database.prepare("SELECT * FROM messages WHERE status = 'queued' AND expires_at <= ?").all(at),
    openForNode: (nodeId) => database.prepare(`SELECT * FROM messages WHERE (target_node = ? OR sender_node = ?)
      AND status IN ('queued','claimed','running')`).all(nodeId, nodeId),
    events: (messageId) => database.prepare('SELECT * FROM events WHERE message_id = ? ORDER BY seq').all(messageId),
    close: () => database.close(),
  };
}
