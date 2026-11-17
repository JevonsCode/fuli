import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// Which FLAs already introduced themselves to the person, and who last owned
// each project's tasks, so a receipt says "nice to meet you" once per FLA and
// "handed over to me" once per change of a project's owner. IDs and the
// owner's display name only; no task content.
export const AGENT_INTRODUCTIONS_FORMAT = sqliteFormat({
  store: 'agent-introductions',
  schema: `
    CREATE TABLE IF NOT EXISTS introduced_agents(
      personal_space_id TEXT NOT NULL, agent_id TEXT NOT NULL, introduced_at TEXT NOT NULL,
      PRIMARY KEY(personal_space_id, agent_id));
    CREATE TABLE IF NOT EXISTS project_owners(
      personal_space_id TEXT NOT NULL, personal_project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      agent_name TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(personal_space_id, personal_project_id));`
});

export class AgentIntroductionStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first owner an entry meets; the first meeting writes the file.
  get db() {
    this.database ??= openFormattedDatabase(this.path, AGENT_INTRODUCTIONS_FORMAT);
    return this.database;
  }

  // This entry's owner meets the person: whether it is the first time, and the
  // project's previous owner when it changed. Both are recorded at once, so
  // each is reported once. projectId null leaves the projects' owners alone.
  // An entry that changes nothing reads and writes nothing else.
  meet({ personalSpaceId, agentId, agentName = null, projectId = null, at }) {
    const seen = () => ({
      met: Boolean(this.db.prepare('SELECT 1 FROM introduced_agents WHERE personal_space_id = ? AND agent_id = ?')
        .get(personalSpaceId, agentId)),
      owner: projectId ? this.db.prepare(`SELECT agent_id, agent_name FROM project_owners
        WHERE personal_space_id = ? AND personal_project_id = ?`).get(personalSpaceId, projectId) ?? null : null
    });
    const current = owner => !projectId || (owner?.agent_id === agentId && owner.agent_name === agentName);
    const before = seen();
    if (before.met && current(before.owner)) return { firstMeeting: false, previousOwner: null };
    return immediateTransaction(this.db, () => {
      const { met, owner } = seen();
      if (!met) this.db.prepare('INSERT INTO introduced_agents VALUES(?, ?, ?)').run(personalSpaceId, agentId, at);
      if (!current(owner)) {
        this.db.prepare(`INSERT INTO project_owners VALUES(?, ?, ?, ?, ?) ON CONFLICT(personal_space_id, personal_project_id)
          DO UPDATE SET agent_id = excluded.agent_id, agent_name = excluded.agent_name, recorded_at = excluded.recorded_at`)
          .run(personalSpaceId, projectId, agentId, agentName, at);
      }
      return { firstMeeting: !met,
        previousOwner: owner && owner.agent_id !== agentId ? { agentId: owner.agent_id, name: owner.agent_name } : null };
    });
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
