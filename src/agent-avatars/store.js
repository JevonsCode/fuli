import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Each Agent's look as the person chose it (rec#11 D-89): a generated look
// from another seed, an uploaded picture, or back to the default. Every choice
// is one new row and nothing is updated or deleted (triggers refuse it), so the
// earlier looks read back as they were. A picture is kept once by its digest.
export const AGENT_AVATARS_FORMAT = sqliteFormat({
  store: 'agent-avatars',
  schema: `
    CREATE TABLE IF NOT EXISTS agent_avatar_images(
      sha256 TEXT PRIMARY KEY, media_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_avatar_looks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, personal_space_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('generated', 'image', 'default')), seed TEXT,
      image_sha256 TEXT REFERENCES agent_avatar_images(sha256), at TEXT NOT NULL,
      CHECK((kind = 'generated') = (seed IS NOT NULL)), CHECK((kind = 'image') = (image_sha256 IS NOT NULL)));
    CREATE INDEX IF NOT EXISTS agent_avatar_looks_agent ON agent_avatar_looks(personal_space_id, agent_id, id);
    CREATE TRIGGER IF NOT EXISTS agent_avatar_images_no_update BEFORE UPDATE ON agent_avatar_images
      BEGIN SELECT RAISE(ABORT, 'agent avatar images are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_avatar_images_no_delete BEFORE DELETE ON agent_avatar_images
      BEGIN SELECT RAISE(ABORT, 'agent avatar images are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_avatar_looks_no_update BEFORE UPDATE ON agent_avatar_looks
      BEGIN SELECT RAISE(ABORT, 'agent avatar looks are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_avatar_looks_no_delete BEFORE DELETE ON agent_avatar_looks
      BEGIN SELECT RAISE(ABORT, 'agent avatar looks are immutable'); END;`
});

const CURRENT = `SELECT * FROM agent_avatar_looks AS look WHERE personal_space_id = ? AND id = (
  SELECT MAX(id) FROM agent_avatar_looks WHERE personal_space_id = look.personal_space_id AND agent_id = look.agent_id)`;

export class AgentAvatarStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first choice; a missing file reads as every Agent on its default look.
  get db() {
    this.database ??= openFormattedDatabase(this.path, AGENT_AVATARS_FORMAT);
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  add({ personalSpaceId, agentId, kind, seed = null, image = null, at }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (image) {
        this.db.prepare('INSERT OR IGNORE INTO agent_avatar_images VALUES(?, ?, ?, ?)')
          .run(image.sha256, image.mediaType, image.bytes, at);
      }
      this.db.prepare(`INSERT INTO agent_avatar_looks(personal_space_id, agent_id, kind, seed, image_sha256, at)
        VALUES(?, ?, ?, ?, ?, ?)`).run(personalSpaceId, agentId, kind, seed, image?.sha256 ?? null, at);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Every Agent's current look that is not the default.
  current(personalSpaceId) {
    if (!this.readable) return [];
    return this.db.prepare(`${CURRENT} AND kind <> 'default' ORDER BY agent_id`).all(personalSpaceId).map(lookView);
  }

  currentOf(personalSpaceId, agentId) {
    if (!this.readable) return null;
    const row = this.db.prepare(`${CURRENT} AND agent_id = ?`).get(personalSpaceId, agentId);
    return row ? lookView(row) : null;
  }

  image(sha256) {
    if (!this.readable) return null;
    const row = this.db.prepare('SELECT media_type, bytes FROM agent_avatar_images WHERE sha256 = ?').get(sha256);
    return row ? { mediaType: row.media_type, bytes: Buffer.from(row.bytes) } : null;
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function lookView(row) {
  return { agentId: row.agent_id, kind: row.kind, seed: row.seed, imageSha256: row.image_sha256, at: row.at };
}
