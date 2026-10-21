import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { openFormattedDatabase, sqliteFormat } from '../storage/database-format.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const STANDALONE_FORMAT = sqliteFormat({
  store: 'standalone',
  schema: `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, clients TEXT NOT NULL,
      responsibility TEXT, status TEXT NOT NULL, employee_number TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      token_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, client TEXT NOT NULL, session_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delegations (
      token_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, client TEXT NOT NULL, session_id TEXT,
      sealed INTEGER NOT NULL DEFAULT 0, origin_key TEXT UNIQUE, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS origins (
      message_id TEXT PRIMARY KEY, digest TEXT NOT NULL, agent_id TEXT NOT NULL, purpose TEXT NOT NULL
    );`,
  pragmas: 'PRAGMA journal_mode = WAL;'
});

// What a standalone install knows about its people: the Agents a person
// registered (one per folder), the tasks of client sessions using them, wake
// authority handed to woken sessions, and this home's own identity keys.
export function createStandaloneStore(path = ':memory:', { now = () => new Date() } = {}) {
  const database = openFormattedDatabase(path, STANDALONE_FORMAT);
  const iso = () => now().toISOString();
  const meta = key => database.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const setMeta = (key, value) => database.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, value);
  const agentView = row => row && ({ agentId: row.agent_id, employeeNumber: row.employee_number, personalProjectId: row.agent_id,
    folder: row.folder, profile: { name: row.name, displayName: row.name, responsibility: row.responsibility ?? null,
      capabilities: [], allowedClients: JSON.parse(row.clients), status: row.status } });

  return {
    // One space per home, created once.
    spaceId() {
      setMeta('space_id', randomUUID());
      return meta('space_id');
    },
    // The Ed25519 key that signs this home's cross-device origins; never rotated silently.
    originKey() {
      if (!meta('origin_key_id')) {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        setMeta('origin_key_id', randomBytes(16).toString('hex'));
        setMeta('origin_private_key', privateKey.export({ format: 'jwk' }).d);
        setMeta('origin_public_key', publicKey.export({ format: 'jwk' }).x);
      }
      return { keyId: meta('origin_key_id'), privateKey: meta('origin_private_key'), publicKey: meta('origin_public_key') };
    },

    addAgent({ name, folder, clients, responsibility = null }) {
      const number = String(database.prepare('SELECT COUNT(*) AS n FROM agents').get().n + 1).padStart(6, '0');
      const agentId = randomUUID();
      database.prepare(`INSERT INTO agents (agent_id, name, folder, clients, responsibility, status, employee_number, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(agentId, name, folder, JSON.stringify(clients), responsibility, number, iso());
      return agentView(database.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId));
    },
    removeAgent(agentId) {
      return database.prepare("UPDATE agents SET status = 'archived' WHERE agent_id = ? AND status = 'active'").run(agentId).changes > 0;
    },
    agents() {
      return database.prepare('SELECT * FROM agents ORDER BY employee_number').all().map(agentView);
    },

    beginTask({ agentId, client, sessionId }) {
      const token = `rt-task-${randomBytes(24).toString('base64url')}`;
      database.prepare('INSERT INTO tasks (token_hash, agent_id, client, session_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(hash(token), agentId, client, sessionId, iso());
      return token;
    },
    task(token) {
      return database.prepare('SELECT * FROM tasks WHERE token_hash = ?').get(hash(String(token))) ?? null;
    },

    issueDelegation({ agentId, client, sessionId = null, lifetimeSeconds, originKey = null }) {
      const token = randomBytes(32).toString('base64url');
      // A remote attempt's record stays: one attempt obtains authority at most once.
      database.prepare('DELETE FROM delegations WHERE expires_at <= ? AND origin_key IS NULL').run(iso());
      const result = database.prepare(`INSERT INTO delegations (token_hash, agent_id, client, session_id, origin_key, expires_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin_key) DO NOTHING`)
        .run(hash(token), agentId, client, sessionId, originKey, new Date(now().getTime() + lifetimeSeconds * 1000).toISOString());
      return result.changes ? token : null;
    },
    sealDelegation(token, sessionId) {
      return database.prepare(`UPDATE delegations SET session_id = ?, sealed = 1
        WHERE token_hash = ? AND expires_at > ? AND (session_id IS NULL OR session_id = ?)`)
        .run(sessionId, hash(token), iso(), sessionId).changes > 0;
    },
    delegation(token) {
      return database.prepare('SELECT * FROM delegations WHERE token_hash = ? AND expires_at > ?').get(hash(String(token)), iso()) ?? null;
    },
    revokeDelegation(token) {
      database.prepare('UPDATE delegations SET expires_at = ? WHERE token_hash = ?').run(new Date(0).toISOString(), hash(token));
    },

    // One message ID names one signed ask; the same ask may be signed again.
    recordOrigin({ messageId, digest, agentId, purpose }) {
      database.prepare('INSERT INTO origins (message_id, digest, agent_id, purpose) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(messageId, digest, agentId, purpose);
      const row = database.prepare('SELECT * FROM origins WHERE message_id = ?').get(messageId);
      return row.digest === digest && row.agent_id === agentId && row.purpose === purpose;
    },

    close() { database.close(); }
  };
}
