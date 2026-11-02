// The desktop-app conversation each Agent answers roundtable asks in, one per
// project and client. Part of the roundtable store format
// (roundtable/5-desktop-inboxes), so every process hands asks to the same one.
export const DESKTOP_INBOX_TABLES = `
    CREATE TABLE IF NOT EXISTS desktop_inboxes (
      space_id TEXT NOT NULL, agent_id TEXT NOT NULL, project_id TEXT NOT NULL, client TEXT NOT NULL,
      conversation_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(space_id, agent_id, project_id, client));
`;

export function createDesktopInboxStore(db) {
  return {
    find: ({ spaceId, agentId, projectId, client }) => db.prepare(`SELECT conversation_id AS conversationId
      FROM desktop_inboxes WHERE space_id = ? AND agent_id = ? AND project_id = ? AND client = ?`)
      .get(spaceId, agentId, projectId, client)?.conversationId ?? null,
    // Two processes may create one at once; the first one recorded is kept.
    remember({ spaceId, agentId, projectId, client, conversationId }) {
      db.prepare(`INSERT INTO desktop_inboxes(space_id, agent_id, project_id, client, conversation_id, created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(spaceId, agentId, projectId, client, conversationId, new Date().toISOString());
      return this.find({ spaceId, agentId, projectId, client });
    },
    forget: ({ spaceId, agentId, projectId, client }) => db.prepare(`DELETE FROM desktop_inboxes
      WHERE space_id = ? AND agent_id = ? AND project_id = ? AND client = ?`).run(spaceId, agentId, projectId, client)
  };
}
