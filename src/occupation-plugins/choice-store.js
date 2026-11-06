import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Which recommended Skills and MCP servers of its occupation's kit an FLA uses,
// as the person answered when it was hired or later on its page. Every answer
// is one new row naming the plugin version and digest it was given for, and
// nothing is updated or deleted (triggers refuse it), so earlier answers read
// back as they were.
export const OCCUPATION_KIT_CHOICES_FORMAT = sqliteFormat({
  store: 'occupation-kit-choices',
  schema: `
    CREATE TABLE IF NOT EXISTS occupation_kit_choices(
      id INTEGER PRIMARY KEY AUTOINCREMENT, personal_space_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL, plugin_version TEXT NOT NULL, plugin_digest TEXT NOT NULL,
      skills TEXT NOT NULL, mcp_servers TEXT NOT NULL,
      answered_by TEXT NOT NULL CHECK(answered_by IN ('person', 'recruitment')), at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS occupation_kit_choices_agent ON occupation_kit_choices(personal_space_id, agent_id, id);
    CREATE TRIGGER IF NOT EXISTS occupation_kit_choices_no_update BEFORE UPDATE ON occupation_kit_choices
      BEGIN SELECT RAISE(ABORT, 'occupation kit choices are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS occupation_kit_choices_no_delete BEFORE DELETE ON occupation_kit_choices
      BEGIN SELECT RAISE(ABORT, 'occupation kit choices are immutable'); END;`
});

const HISTORY_LIMIT = 20;

export class OccupationKitChoiceStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first answer; a missing file reads as no FLA asked yet.
  get db() {
    this.database ??= openFormattedDatabase(this.path, OCCUPATION_KIT_CHOICES_FORMAT);
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  add({ personalSpaceId, agentId, pluginId, pluginVersion, pluginDigest, skills, mcpServers, answeredBy, at }) {
    this.db.prepare(`INSERT INTO occupation_kit_choices(personal_space_id, agent_id, plugin_id, plugin_version,
      plugin_digest, skills, mcp_servers, answered_by, at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(personalSpaceId, agentId, pluginId, pluginVersion, pluginDigest, JSON.stringify(skills),
        JSON.stringify(mcpServers), answeredBy, at);
  }

  // Newest first: the current answer, then the earlier ones.
  history(personalSpaceId, agentId, limit = HISTORY_LIMIT) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM occupation_kit_choices WHERE personal_space_id = ? AND agent_id = ?
      ORDER BY id DESC LIMIT ?`).all(personalSpaceId, agentId, limit).map(choiceView);
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function choiceView(row) {
  return { pluginId: row.plugin_id, pluginVersion: row.plugin_version, pluginDigest: row.plugin_digest,
    skills: JSON.parse(row.skills), mcpServers: JSON.parse(row.mcp_servers), answeredBy: row.answered_by, at: row.at };
}
