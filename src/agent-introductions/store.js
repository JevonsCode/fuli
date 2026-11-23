import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Which FLAs the person already knows, and who last owned each project's
// tasks, so a receipt says "nice to meet you" once per new FLA and "handed
// over to me" once per change of a project's owner. An FLA created before
// introductions began (introductions_since, the moment this store was
// created) is known without one. IDs and the owner's display name only; no
// task content.
export const AGENT_INTRODUCTIONS_FILE = 'agent-introductions.sqlite';
export const AGENT_INTRODUCTIONS_FORMAT = sqliteFormat({
  store: 'agent-introductions',
  schema: `
    CREATE TABLE IF NOT EXISTS introductions_since(
      id INTEGER PRIMARY KEY CHECK(id = 1), since TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS known_agents(
      personal_space_id TEXT NOT NULL, agent_id TEXT NOT NULL, known_at TEXT NOT NULL,
      PRIMARY KEY(personal_space_id, agent_id));
    CREATE TABLE IF NOT EXISTS project_owners(
      personal_space_id TEXT NOT NULL, personal_project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      agent_name TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(personal_space_id, personal_project_id));`
});

export class AgentIntroductionStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Closing is final: an entry still running after its hook's deadline closed
  // the application must not reopen the file and hold it past the hook.
  get db() {
    if (this.closed) throw new Error('Agent introductions are closed');
    this.database ??= openFormattedDatabase(this.path, AGENT_INTRODUCTIONS_FORMAT);
    return this.database;
  }

  // Creates the store the first time FULI opens this data directory with it,
  // keeping when introductions began (since(), asked only then): only an FLA
  // created after it is new to the person. An existing file is not opened.
  begin(since) {
    if (this.path !== ':memory:' && existsSync(this.path)) return;
    this.db.prepare('INSERT OR IGNORE INTO introductions_since VALUES(1, ?)').run(since());
  }

  // This entry's owner meets the person: whether it is new to them (created
  // after introductions began and not met yet), and the project's previous
  // owner when it changed. Both are recorded at once, so each is reported
  // once. projectId null leaves the projects' owners alone. An entry that
  // changes nothing reads and writes nothing else.
  meet({ personalSpaceId, agentId, agentCreatedAt = null, agentName = null, projectId = null, at }) {
    const seen = () => ({
      known: Boolean(this.db.prepare('SELECT 1 FROM known_agents WHERE personal_space_id = ? AND agent_id = ?')
        .get(personalSpaceId, agentId)),
      owner: projectId ? this.db.prepare(`SELECT agent_id, agent_name FROM project_owners
        WHERE personal_space_id = ? AND personal_project_id = ?`).get(personalSpaceId, projectId) ?? null : null
    });
    const current = owner => !projectId || (owner?.agent_id === agentId && owner.agent_name === agentName);
    const before = seen();
    if (before.known && current(before.owner)) return { firstMeeting: false, previousOwner: null };
    return immediateTransaction(this.db, () => {
      const { known, owner } = seen();
      if (!known) this.db.prepare('INSERT INTO known_agents VALUES(?, ?, ?)').run(personalSpaceId, agentId, at);
      if (!current(owner)) {
        this.db.prepare(`INSERT INTO project_owners VALUES(?, ?, ?, ?, ?) ON CONFLICT(personal_space_id, personal_project_id)
          DO UPDATE SET agent_id = excluded.agent_id, agent_name = excluded.agent_name, recorded_at = excluded.recorded_at`)
          .run(personalSpaceId, projectId, agentId, agentName, at);
      }
      return { firstMeeting: !known && createdSince(this.db, agentCreatedAt),
        previousOwner: owner && owner.agent_id !== agentId ? { agentId: owner.agent_id, name: owner.agent_name } : null };
    });
  }

  close() {
    this.closed = true;
    this.database?.close();
    this.database = null;
  }
}

// An FLA whose creation time is unknown, or before introductions began, is
// one the person already works with.
function createdSince(db, agentCreatedAt) {
  const since = db.prepare('SELECT since FROM introductions_since WHERE id = 1').get()?.since;
  const created = Date.parse(agentCreatedAt ?? '');
  return Boolean(since) && Number.isFinite(created) && created >= Date.parse(since);
}
