import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { roundCost } from './budget.js';

// U-09 / D-04 usage ledger: one immutable row per actual attempt, keyed by
// (requestId, attemptId) so a duplicate report of the same attempt is stored
// once. Logical requests are distinct requestIds. Rows never hold prompt
// text, model output or keys. The channel keeps independent model API usage
// apart from current-session usage.

const MAX_GROUPS = 200;
const TOKEN_FIELDS = Object.freeze([
  ['input', 'input_tokens'], ['output', 'output_tokens'], ['total', 'total_tokens'],
  ['cachedInput', 'cached_input_tokens'], ['cacheWriteInput', 'cache_write_input_tokens'], ['reasoning', 'reasoning_tokens']
]);
const SUBSET_FIELDS = new Set(['cachedInput', 'cacheWriteInput', 'reasoning']);

export class ModelUsageLedger {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on first use, so a process that never reads usage creates no file.
  get db() {
    if (this.database) return this.database;
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec(`PRAGMA busy_timeout = 5000;
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
      CREATE TRIGGER IF NOT EXISTS model_attempts_no_update BEFORE UPDATE ON model_attempts
        BEGIN SELECT RAISE(ABORT, 'model attempts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS model_attempts_no_delete BEFORE DELETE ON model_attempts
        BEGIN SELECT RAISE(ABORT, 'model attempts are immutable'); END;`);
    this.database = db;
    return db;
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

  // Model API spending of one role since an ISO time, for its budget check.
  window({ role, since }) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS reported,
        COALESCE(SUM(CASE WHEN total_tokens IS NULL THEN budget_ceiling_tokens END), 0) AS reserved,
        COALESCE(SUM(estimated_cost), 0) AS cost,
        COALESCE(SUM(CASE WHEN estimated_cost IS NULL THEN COALESCE(total_tokens, budget_ceiling_tokens) END), 0) AS unpriced
      FROM model_attempts WHERE role = ? AND channel = 'model_api' AND started_at >= ?`).get(role, since);
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

  close() {
    this.database?.close();
    this.database = null;
  }
}
