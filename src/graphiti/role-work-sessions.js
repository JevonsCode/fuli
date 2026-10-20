// The session behind a role_work call is the Provider's durable task context
// for its token, never a session ID taken from the payload. The Agent access
// switch is checked before any tool handler runs.
export function roleWorkSessions(app) {
  return async ({ taskContextToken, sourceApplication }) => {
    const task = await app.taskContextRegistry.context(taskContextToken, sourceApplication);
    return { sessionRef: task.sessionId, personalSpaceId: app.config.personal.spaceId,
      personalProjectId: task.personalProjectId ?? null, sourceApplication: task.sourceApplication ?? sourceApplication, taskContextToken };
  };
}
