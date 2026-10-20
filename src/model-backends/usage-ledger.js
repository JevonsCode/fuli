import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/sqlite-format.js';

import { roundCost } from './budget.js';

// U-09 / D-04 usage ledger: one immutable row per actual attempt, keyed by
// (requestId, attemptId) so a duplicate report of the same attempt is stored
// once. Logical requests are distinct requestIds. Rows never hold prompt
// text, model output or keys. The channel keeps independent model API usage
// apart from current-session usage.
//
// Before an attempt goes out it reserves its token (and, when priced, cost)
// ceiling: one IMMEDIATE transaction checks the role's window and inserts the
// reservation, so concurrent attempts, also from other processes sharing this
// file, cannot pass the window together. Settling replaces the reservation
// with the attempt record. An unsettled reservation counts at its ceiling;
// once it has expired, no live attempt can still own it, and it becomes an
// attempt record with unknown usage, which keeps counting at that ceiling.

const MAX_GROUPS = 200;
const TOKEN_FIELDS = Object.freeze([
  ['input', 'input_tokens'], ['output', 'output_tokens'], ['total', 'total_tokens'],
  ['cachedInput', 'cached_input_tokens'], ['cacheWriteInput', 'cache_write_input_tokens'], ['reasoning', 'reasoning_tokens']
]);
const SUBSET_FIELDS = new Set(['cachedInput', 'cacheWriteInput', 'reasoning']);
const UNKNOWN_USAGE = Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null,
  cacheWriteInputTokens: null, reasoningTokens: null, definition: null });

const MODEL_USAGE_FORMAT = sqliteFormat({
  store: 'model-usage',
  schema: `
      CREATE TABLE IF NOT EXISTS model_attempts(
        request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('initial', 'retry', 'repair', 'format_fallback')),
        channel TEXT NOT NULL CHECK(channel IN ('model_api', 'session')),
        role TEXT NOT NULL, operation TEXT NOT NULL, personal_space_id TEXT NOT NULL, personal_project_id TEXT,
        connection_id TEXT, protocol TEXT, endpoint_host TEXT, requested_model TEXT, actual_model TEXT, output_mode TEXT,
        started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed', 'invalid_output')),
        failure_class TEXT, failure_reason TEXT,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER, reasoning_tokens INTEGER, usage_definition TEXT,
        budget_ceiling_tokens INTEGER NOT NULL, estimated_cost REAL, cost_currency TEXT,
        PRIMARY KEY(request_id, attempt_id));
      CREATE INDEX IF NOT EXISTS model_attempts_role_time ON model_attempts(role, started_at);
      CREATE TABLE IF NOT EXISTS model_reservations(
        request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, role TEXT NOT NULL, started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, ceiling_tokens INTEGER NOT NULL, ceiling_cost REAL, pending_attempt TEXT NOT NULL,
        PRIMARY KEY(request_id, attempt_id));
      CREATE INDEX IF NOT EXISTS model_reservations_role_time ON model_reservations(role, started_at);
      CREATE TRIGGER IF NOT EXISTS model_attempts_no_update BEFORE UPDATE ON model_attempts
        BEGIN SELECT RAISE(ABORT, 'model attempts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS model_attempts_no_delete BEFORE DELETE ON model_attempts
        BEGIN SELECT RAISE(ABORT, 'model attempts are immutable'); END;`
});

export class ModelUsageLedger {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on first use, so a process that never reads usage creates no file.
  get db() {
    if (this.database) return this.database;
    this.database = openFormattedDatabase(this.path, MODEL_USAGE_FORMAT);
    return this.database;
  }

  // True when stored, false when this (requestId, attemptId) already exists.
  record(attempt) {
    const { usage } = attempt;
    const result = this.db.prepare(`INSERT INTO model_attempts VALUES(${Array(30).fill('?').join(',')})
      ON CONFLICT(request_id, attempt_id) DO NOTHING`).run(
      attempt.requestId, attempt.attemptId, attempt.attemptNumber, attempt.purpose, attempt.channel,
      attempt.role, attempt.operation, attempt.personalSpaceId, attempt.personalProjectId,
      attempt.connectionId, attempt.protocol, attempt.endpointHost, attempt.requestedModel, attempt.actualModel,
      attempt.outputMode, attempt.startedAt, attempt.durationMs, attempt.outcome, attempt.failureClass, attempt.failureReason,
      usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
      usage.reasoningTokens, usage.definition, attempt.budgetCeilingTokens, attempt.estimatedCost, attempt.costCurrency);
    return result.changes === 1;
  }

  // Checks the role's window and, when check(window) names no reason to
  // stop, reserves the pending attempt's ceiling. Returns that reason or null.
  // pending holds the attempt's metadata, never prompt text.
  reserve({ attempt: pending, ceilingCost, expiresAt, since, now, check }) {
    return this.#transaction(() => {
      this.#reclaimExpired(now);
      const blocked = check(this.window({ role: pending.role, since }));
      if (blocked) return blocked;
      this.db.prepare('INSERT INTO model_reservations VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(pending.requestId, pending.attemptId,
        pending.role, pending.startedAt, expiresAt, pending.budgetCeilingTokens, ceilingCost, JSON.stringify(pending));
      return null;
    });
  }

  // Records the finished attempt in place of its reservation.
  settle(attempt) {
    return this.#transaction(() => {
      this.db.prepare('DELETE FROM model_reservations WHERE request_id = ? AND attempt_id = ?').run(attempt.requestId, attempt.attemptId);
      return this.record(attempt);
    });
  }

  // Settles an attempt whose outcome is unknown: it counts at its ceiling.
  settleUnknown(pending, { durationMs, failureReason }) {
    return this.settle({ ...pending, actualModel: null, durationMs, outcome: 'failed', failureClass: 'transient', failureReason,
      usage: UNKNOWN_USAGE, estimatedCost: null });
  }

  #reclaimExpired(now) {
    const expired = this.db.prepare('SELECT started_at, expires_at, pending_attempt FROM model_reservations WHERE expires_at <= ?').all(now);
    for (const row of expired) {
      this.settleUnknown(JSON.parse(row.pending_attempt),
        { durationMs: Date.parse(row.expires_at) - Date.parse(row.started_at), failureReason: 'unsettled' });
    }
  }

  // Model API spending of one role since an ISO time, for its budget check.
  // In-flight reservations count at their ceilings.
  window({ role, since }) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS reported,
        COALESCE(SUM(CASE WHEN total_tokens IS NULL THEN ceiling END), 0) AS reserved,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(CASE WHEN cost IS NULL THEN COALESCE(total_tokens, ceiling) END), 0) AS unpriced
      FROM (SELECT total_tokens, budget_ceiling_tokens AS ceiling, estimated_cost AS cost FROM model_attempts
          WHERE role = ?1 AND channel = 'model_api' AND started_at >= ?2
        UNION ALL SELECT NULL, ceiling_tokens, ceiling_cost FROM model_reservations WHERE role = ?1 AND started_at >= ?2)`)
      .get(role, since);
    return { reportedTokens: row.reported, reservedTokens: row.reserved, estimatedCost: roundCost(row.cost), unpricedTokens: row.unpriced };
  }

  // Grouped by role, provider (protocol and endpoint host), configured model
  // and channel; the models the provider reported are listed per group.
  usage({ role = null, from = null, to = null }) {
    const tokenColumns = TOKEN_FIELDS.map(([name, column]) =>
      `SUM(${column}) AS ${name}_reported, SUM(${column} IS NULL) AS ${name}_unknown`).join(', ');
    const rows = this.db.prepare(`SELECT role, protocol, endpoint_host, requested_model, json_group_array(DISTINCT actual_model) AS actual_models,
        channel, cost_currency, COUNT(DISTINCT request_id) AS requests, COUNT(*) AS attempts,
        SUM(purpose = 'retry') AS retries, SUM(purpose = 'repair') AS repairs,
        SUM(outcome != 'succeeded') AS failed_attempts,
        COUNT(DISTINCT request_id) - COUNT(DISTINCT CASE WHEN outcome = 'succeeded' THEN request_id END) AS failed_requests,
        ${tokenColumns}, SUM(estimated_cost) AS cost, SUM(estimated_cost IS NULL) AS cost_unknown
      FROM model_attempts
      WHERE (?1 IS NULL OR role = ?1) AND (?2 IS NULL OR started_at >= ?2) AND (?3 IS NULL OR started_at < ?3)
      GROUP BY role, protocol, endpoint_host, requested_model, channel, cost_currency
      ORDER BY role, requested_model LIMIT ${MAX_GROUPS}`).all(role, from, to);
    return rows.map(row => ({
      role: row.role,
      provider: row.protocol ? `${row.protocol}@${row.endpoint_host}` : null,
      model: row.requested_model,
      actualModels: JSON.parse(row.actual_models).filter(Boolean),
      channel: row.channel,
      requests: row.requests,
      attempts: row.attempts,
      retries: row.retries,
      repairs: row.repairs,
      failedAttempts: row.failed_attempts,
      failedRequests: row.failed_requests,
      tokens: Object.fromEntries(TOKEN_FIELDS
        .filter(([name]) => !SUBSET_FIELDS.has(name) || row[`${name}_reported`] !== null)
        .map(([name]) => [name, { reported: row[`${name}_reported`], unknownAttempts: row[`${name}_unknown`] }])),
      estimatedCost: row.cost_currency ? { amount: row.cost === null ? null : roundCost(row.cost), currency: row.cost_currency,
        basis: 'estimate', unknownAttempts: row.cost_unknown } : null
    }));
  }

  // Nested calls join the open transaction.
  #transaction(work) {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
