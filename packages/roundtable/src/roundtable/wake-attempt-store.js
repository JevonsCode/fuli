// Every wake an ask started on this computer and how it ended: the client, a
// resumed or new session, the failure code and its detail (wake-failure.js),
// exit code and signal, how long it ran, and a redacted, bounded summary of the
// client's output. Kept where the wake ran and never sent to another computer.
// Part of the roundtable store format (roundtable/10-wake-attempts). Since
// roundtable/11-wake-attempt-usage each attempt also keeps the model and tokens
// the woken client reported for it, answered or failed; null when none.
export const WAKE_ATTEMPT_TABLES = `
    CREATE TABLE IF NOT EXISTS wake_attempts (
      message_id TEXT NOT NULL, attempt INTEGER NOT NULL, client TEXT NOT NULL, session_mode TEXT NOT NULL,
      outcome TEXT NOT NULL, code TEXT, detail TEXT, exit_code INTEGER, signal TEXT, duration_ms INTEGER,
      output_summary TEXT, created_at TEXT NOT NULL, PRIMARY KEY(message_id, attempt));
`;
export const WAKE_ATTEMPT_USAGE_COLUMNS = Object.freeze({ model: 'TEXT', input_tokens: 'INTEGER', output_tokens: 'INTEGER' });

export function createWakeAttemptStore(db, now) {
  return {
    // The attempt number is the next one of this ask, decided in the insert itself.
    record(messageId, { client, sessionMode, outcome, code, detail, exitCode, signal, durationMs, outputSummary,
      model = null, inputTokens = null, outputTokens = null }) {
      db.prepare(`INSERT INTO wake_attempts(message_id, attempt, client, session_mode, outcome, code, detail,
          exit_code, signal, duration_ms, output_summary, created_at, model, input_tokens, output_tokens)
        SELECT ?, coalesce(max(attempt), 0) + 1, ?,?,?,?,?,?,?,?,?,?,?,?,? FROM wake_attempts WHERE message_id = ?`)
        .run(messageId, client, sessionMode, outcome, code, detail, exitCode, signal, durationMs, outputSummary, now(),
          model, inputTokens, outputTokens, messageId);
    },
    forMessage: messageId => db.prepare(`SELECT attempt, client, session_mode AS sessionMode, outcome, code, detail,
        exit_code AS exitCode, signal, duration_ms AS durationMs, output_summary AS outputSummary, created_at AS createdAt
      FROM wake_attempts WHERE message_id = ? ORDER BY attempt`).all(messageId),
    // Wakes of this space's asks in [from, to), per client and the model it
    // reported (null: none), most first: answered and failed apart. Tokens add
    // up only what clients reported; tokenWakes says how many wakes reported any.
    usageBetween: (spaceId, from, to) => db.prepare(`SELECT w.client AS client, w.model AS model,
          count(CASE WHEN w.outcome = 'answered' THEN 1 END) AS wakes, count(CASE WHEN w.outcome <> 'answered' THEN 1 END) AS failedWakes,
          sum(w.input_tokens) AS inputTokens, sum(w.output_tokens) AS outputTokens,
          count(coalesce(w.input_tokens, w.output_tokens)) AS tokenWakes
        FROM wake_attempts w JOIN messages m ON m.id = w.message_id JOIN threads t ON t.id = m.thread_id
        WHERE t.space_id = ? AND w.created_at >= ? AND w.created_at < ?
        GROUP BY w.client, w.model ORDER BY count(*) DESC, client, model`).all(spaceId, from, to).map(row => ({ ...row }))
  };
}
