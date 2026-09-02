// Synthetic HTTP boundary double. Real persistence is tested separately against
// a disposable Neo4j Provider, not inferred from this Map.
export function taskContextProviderFixture() {
  const sessions = new Map();
  const tokens = new Map();
  const key = (input) => `${input.personal_space_id}:${input.source_application}:${input.session_id}`;
  return ({ path, body, query, method }) => {
    if (path === '/v1/task-contexts') {
      const record = { ...body, checkpoint: null };
      record.previous_checkpoint_missing = Boolean(sessions.get(key(body))?.checkpoint === null);
      sessions.set(key(body), record);
      tokens.set(record.token, record);
      return record;
    }
    if (path === '/v1/task-context-sessions/checkpoint') {
      const record = sessions.get(key(query));
      if (!record) return { status: 'not_started' };
      if (record.checkpoint?.phase === 'complete') {
        return { status: 'checkpointed', disposition: record.checkpoint.disposition };
      }
      return { status: 'checkpoint_required', decision: 'block',
        reason: 'Call checkpoint_task_knowledge before finishing.', task_context_token: record.token };
    }
    if (path.startsWith('/v1/task-contexts/')) {
      const token = decodeURIComponent(path.split('/')[3]);
      const record = tokens.get(token);
      if (method === 'PUT') record.checkpoint = body;
      return record;
    }
    return null;
  };
}
