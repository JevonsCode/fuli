import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { ApplicationError } from '../app/application-error.js';
import { MODEL_BACKEND_ROLES } from './config.js';

// Whether a built-in Agent's own model may carry out an operation by itself
// (rec#10 D-36.5–D-36.12, replacing the D-24 build registry). A role the
// person configured with a model is trusted by default: its automatic
// operations (today Tonborg's knowledge review write-back) apply what that
// model answered, unless the person switched the role to 「只给建议」, or has
// not yet acknowledged the one-line warning on the settings page. An answer
// from the current session (no model, a disabled role, or a fallback after
// the model failed) is always a suggestion, as before.
//
// Trust relaxes nothing else: permission, egress, the person's own policy and
// safety rules, the capture switch, injection isolation and the hard-delete
// fence are each checked by their owners as before; this module only adds the
// role's model and egress approval as they are when the answer is used.
//
// The choice and the acknowledgement live in their own store, one row per
// role. No row is the default: trusted, warning not seen. Nothing migrates
// into it, so an upgrade resets no existing choice. The warning is seen only
// when the person acknowledges it on the settings page (the loopback route);
// rendering a receipt or the page does not count.
//
// A commit (commit below) holds this store's write lock while it checks the
// role and runs the caller's write, and every change of a role takes the same
// lock, so a switch to 「只给建议」 either lands before a commit (which then
// refuses) or after it. The caller's write is its commit point (Tonborg
// stores its apply intent there): a task committed before the switch has
// started and completes, like a write that finished a moment earlier.

export const MODEL_TRUST_FORMAT = sqliteFormat({
  store: 'model-trust',
  schema: `
      CREATE TABLE IF NOT EXISTS role_trust(
        role TEXT PRIMARY KEY, suggestions_only INTEGER NOT NULL, suggestions_only_at TEXT,
        warning_version INTEGER, warning_seen_at TEXT, revision INTEGER NOT NULL);`
});
// The warning the person acknowledges; a change of its meaning is a new version to see again.
const TRUST_WARNING_VERSION = 1;

const DEFAULT_STATE = Object.freeze({ suggestionsOnly: false, suggestionsOnlyAt: null, warningSeen: false,
  warningSeenAt: null, revision: 0 });

// modelBackends: the model port (port.js), read on every check.
export function createRoleTrust({ path = ':memory:', modelBackends, now = () => new Date() }) {
  let database = null;
  // Opened on first change; a missing file is the default state, never created by a read.
  const open = () => (database ??= openFormattedDatabase(path, MODEL_TRUST_FORMAT));
  const readable = () => database || path === ':memory:' || existsSync(path);

  function state(role) {
    if (!readable()) return DEFAULT_STATE;
    const row = open().prepare('SELECT * FROM role_trust WHERE role = ?').get(role);
    if (!row) return DEFAULT_STATE;
    return { suggestionsOnly: row.suggestions_only === 1, suggestionsOnlyAt: row.suggestions_only_at,
      warningSeen: row.warning_version === TRUST_WARNING_VERSION, warningSeenAt: row.warning_seen_at, revision: row.revision };
  }

  // key: { role, operation, connection, model, scope }. connection: the
  // identity of the configured connection that answered (config.js
  // connectionIdentity), null for a current-session answer; model names it in
  // receipts. scope: the answer's { personalSpaceId, personalProjectId },
  // checked against the role's egress approval as it is now; omitted for the
  // settings view, which has no answer.
  function verdict(key, current) {
    const refuse = reason => ({ status: 'not_passed', reason, modelId: key.model ?? null });
    if (!key.connection) return refuse('session_answer');
    const settings = modelBackends.operationSettings(key.role, key.operation);
    if (!settings) return refuse('not_configured');
    // Another connection, endpoint, protocol or model than the one that answered.
    if (settings.connection.identity !== key.connection) return refuse('connection_changed');
    if (key.scope && !modelBackends.allowsEgress(egressRequest(key))) return refuse('egress_not_approved');
    if (current.suggestionsOnly) return refuse('suggestions_only');
    if (!current.warningSeen) return refuse('warning_not_seen');
    return { status: 'passed', reason: null, modelId: key.model };
  }

  function change(role, expectedRevision, columns) {
    if (!MODEL_BACKEND_ROLES.includes(role)) throw new TypeError(`Unknown role: ${role}`);
    return locked(open(), () => {
      const current = state(role);
      if (current.revision !== expectedRevision) {
        throw new ApplicationError('model_trust_changed',
          'This role\'s execution mode changed since the page read it. Nothing was saved; read it again.', { status: 409 });
      }
      const next = { suggestions_only: current.suggestionsOnly ? 1 : 0, suggestions_only_at: current.suggestionsOnlyAt,
        warning_version: current.warningSeen ? TRUST_WARNING_VERSION : null, warning_seen_at: current.warningSeenAt, ...columns };
      open().prepare(`INSERT INTO role_trust VALUES(:role, :suggestions_only, :suggestions_only_at, :warning_version,
          :warning_seen_at, :revision) ON CONFLICT(role) DO UPDATE SET suggestions_only = excluded.suggestions_only,
          suggestions_only_at = excluded.suggestions_only_at, warning_version = excluded.warning_version,
          warning_seen_at = excluded.warning_seen_at, revision = excluded.revision`)
        .run({ role, ...next, revision: expectedRevision + 1 });
    });
  }

  return {
    // What an answer may do by itself if it were used now.
    status: key => verdict(key, state(key.role)),
    // Runs write() (synchronous) only while the verdict passes, under the
    // lock every change of a role takes. A refusal throws 409 with the
    // verdict's reason and runs nothing. Without the store's file no warning
    // was ever acknowledged, so nothing can pass and no file is created.
    commit(key, write) {
      const refuse = gate => Object.assign(new ApplicationError(gate.reason, `Not executed automatically: ${gate.reason}`,
        { status: 409 }), { gate });
      if (!readable()) throw refuse(verdict(key, DEFAULT_STATE));
      return locked(open(), () => {
        const gate = verdict(key, state(key.role));
        if (gate.status !== 'passed') throw refuse(gate);
        return write(gate);
      });
    },
    // What the settings page shows of a role whose operations may run by
    // themselves: the person's choice, the acknowledgement, and whether the
    // configured model would execute now.
    view(role, operation) {
      const current = state(role);
      const settings = modelBackends.operationSettings(role, operation);
      const gate = verdict({ role, operation, connection: settings?.connection.identity ?? null,
        model: settings?.connection.model ?? null }, current);
      return { suggestionsOnly: current.suggestionsOnly, warningSeen: current.warningSeen,
        warningSeenAt: current.warningSeenAt, warningVersion: TRUST_WARNING_VERSION, revision: current.revision,
        status: gate.status === 'passed' ? 'automatic' : 'suggestion', reason: gate.reason };
    },
    setSuggestionsOnly(role, suggestionsOnly, expectedRevision) {
      change(role, expectedRevision, { suggestions_only: suggestionsOnly ? 1 : 0, suggestions_only_at: now().toISOString() });
    },
    acknowledgeWarning(role, warningVersion, expectedRevision) {
      if (warningVersion !== TRUST_WARNING_VERSION) {
        throw new ApplicationError('model_trust_warning_changed', 'The warning changed since the page showed it; read it again.', { status: 409 });
      }
      change(role, expectedRevision, { warning_version: TRUST_WARNING_VERSION, warning_seen_at: now().toISOString() });
    },
    close() { database?.close(); database = null; }
  };
}

// The egress question the port answers for a review's own request shape:
// every evidence item belongs to the answer's project (judgment backend).
function egressRequest({ role, operation, scope }) {
  const personalProjectId = scope.personalProjectId ?? null;
  return { role, operation, scope: { personalSpaceId: scope.personalSpaceId, personalProjectId },
    evidence: [{ personalProjectId }] };
}

function locked(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
