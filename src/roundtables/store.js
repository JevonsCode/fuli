import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from './domain.js';

/** Collaboration persistence owns transactions, CAS, sequence and capability records. */
export function createRoundtableStore({ databasePath = ':memory:' } = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS roundtable_rooms (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roundtable_messages (room_id TEXT NOT NULL REFERENCES roundtable_rooms(id), seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, PRIMARY KEY(room_id,seq));
    CREATE TABLE IF NOT EXISTS roundtable_invites (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES roundtable_rooms(id), seat_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS roundtable_idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key));
    CREATE TABLE IF NOT EXISTS roundtable_late_evidence (room_id TEXT NOT NULL REFERENCES roundtable_rooms(id), attempt_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room_id,attempt_id));
  `);
  let closed = false;
  const decode = row => row ? JSON.parse(row.state) : null;
  return {
    transaction(work) {
      if (closed) fail('store_closed', 'Roundtable service is closed', 503);
      database.exec('BEGIN IMMEDIATE');
      try { const result = work(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    getRoom(id) { return decode(database.prepare('SELECT state FROM roundtable_rooms WHERE id=?').get(id)); },
    listRooms() { return database.prepare('SELECT state FROM roundtable_rooms ORDER BY rowid DESC').all().map(decode); },
    insertRoom(room) { database.prepare('INSERT INTO roundtable_rooms(id,revision,state) VALUES(?,?,?)').run(room.id, room.revision, JSON.stringify(room)); },
    saveRoom(room, expectedRevision) {
      room.revision = expectedRevision + 1;
      const changed = database.prepare('UPDATE roundtable_rooms SET revision=?,state=? WHERE id=? AND revision=?').run(room.revision, JSON.stringify(room), room.id, expectedRevision);
      if (changed.changes !== 1) fail('revision_conflict', 'Roundtable changed; read the current revision', 409);
    },
    appendMessage(roomId, message) { database.prepare('INSERT INTO roundtable_messages(room_id,seq,id,data) VALUES(?,?,?,?)').run(roomId, message.seq, message.id, JSON.stringify(message)); },
    messages(roomId, afterSeq = 0, limit = 100) { return database.prepare('SELECT data FROM roundtable_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?').all(roomId, afterSeq, limit).map(row => JSON.parse(row.data)); },
    recentMessages(roomId, limit = 12) { return database.prepare('SELECT data FROM roundtable_messages WHERE room_id=? ORDER BY seq DESC LIMIT ?').all(roomId, limit).reverse().map(row => JSON.parse(row.data)); },
    recordLateEvidence(roomId, attemptId, evidence) { database.prepare('INSERT OR IGNORE INTO roundtable_late_evidence(room_id,attempt_id,data) VALUES(?,?,?)').run(roomId, attemptId, JSON.stringify(evidence)); },
    lateEvidence(roomId) { return database.prepare('SELECT data FROM roundtable_late_evidence WHERE room_id=? ORDER BY rowid').all(roomId).map(row => JSON.parse(row.data)); },
    getIdempotent(scope, key, payloadHash) {
      if (!key) return null;
      const row = database.prepare('SELECT payload_hash,response FROM roundtable_idempotency WHERE scope=? AND key=?').get(scope, key);
      if (!row) return null;
      if (row.payload_hash !== payloadHash) fail('idempotency_conflict', 'Idempotency key was used for different input', 409);
      return JSON.parse(row.response);
    },
    saveIdempotent(scope, key, payloadHash, response) { database.prepare('INSERT INTO roundtable_idempotency(scope,key,payload_hash,response) VALUES(?,?,?,?)').run(scope, key, payloadHash, JSON.stringify(response)); },
    insertInvite(invite) { database.prepare('INSERT INTO roundtable_invites(id,room_id,seat_id,token_hash,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)').run(invite.id, invite.roomId, invite.seatId, invite.tokenHash, invite.expiresAt); },
    inviteByHash(hash) { return database.prepare('SELECT * FROM roundtable_invites WHERE token_hash=?').get(hash) ?? null; },
    inviteById(id) { return database.prepare('SELECT * FROM roundtable_invites WHERE id=?').get(id) ?? null; },
    revokeInvite(roomId, seatId, inviteId, now) {
      if (inviteId) return database.prepare('UPDATE roundtable_invites SET revoked_at=? WHERE room_id=? AND id=? AND revoked_at IS NULL').run(now, roomId, inviteId).changes;
      return database.prepare('UPDATE roundtable_invites SET revoked_at=? WHERE room_id=? AND seat_id=? AND revoked_at IS NULL').run(now, roomId, seatId).changes;
    },
    close() { if (!closed) { closed = true; database.close(); } }
  };
}
