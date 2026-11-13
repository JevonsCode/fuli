// Every wake an ask started on this computer and how it ended: the client, a
// resumed or new session, the failure code and its detail (wake-failure.js),
// exit code and signal, how long it ran, and a redacted, bounded summary of the
// client's output. Kept where the wake ran and never sent to another computer.
// Part of the roundtable store format (roundtable/10-wake-attempts).
export const WAKE_ATTEMPT_TABLES = `
    CREATE TABLE IF NOT EXISTS wake_attempts (
      message_id TEXT NOT NULL, attempt INTEGER NOT NULL, client TEXT NOT NULL, session_mode TEXT NOT NULL,
      outcome TEXT NOT NULL, code TEXT, detail TEXT, exit_code INTEGER, signal TEXT, duration_ms INTEGER,
      output_summary TEXT, created_at TEXT NOT NULL, PRIMARY KEY(message_id, attempt));
`;

export function createWakeAttemptStore(db, now) {
  return {
    // The attempt number is the next one of this ask, decided in the insert itself.
    record(messageId, { client, sessionMode, outcome, code, detail, exitCode, signal, durationMs, outputSummary }) {
      db.prepare(`INSERT INTO wake_attempts(message_id, attempt, client, session_mode, outcome, code, detail,
          exit_code, signal, duration_ms, output_summary, created_at)
        SELECT ?, coalesce(max(attempt), 0) + 1, ?,?,?,?,?,?,?,?,?,? FROM wake_attempts WHERE message_id = ?`)
        .run(messageId, client, sessionMode, outcome, code, detail, exitCode, signal, durationMs, outputSummary, now(), messageId);
    },
    forMessage: messageId => db.prepare(`SELECT attempt, client, session_mode AS sessionMode, outcome, code, detail,
        exit_code AS exitCode, signal, duration_ms AS durationMs, output_summary AS outputSummary, created_at AS createdAt
      FROM wake_attempts WHERE message_id = ? ORDER BY attempt`).all(messageId)
  };
}
