// The visit request rows and their events in the visitor-access store
// (format version 3). Reads and writes only; which change of state is allowed
// is decided by service.js, which runs every multi-row change in the store's
// transaction. Every state change goes through move(), which writes its event
// in the same statement group, so no state changes without its record.
const OPEN_STATES = Object.freeze(['received', 'planning', 'awaiting_owner', 'approved', 'running']);
// Counted toward a requester's open cap: a result still waiting for review holds a worktree too.
const HELD_OPEN_STATES = Object.freeze([...OPEN_STATES, 'awaiting_review']);
const EVENTS_PER_REQUEST = 200;

export function createVisitRecords(store) {
  const db = () => store.db;

  return {
    OPEN_STATES,

    insert(row) {
      db().prepare(`INSERT INTO visit_requests(id, requester_key, requester_label, agent_name, source, project_id, agent_id,
        project_folder, title, what, requester_areas_json, state, mode_at_receipt, reason, planning_ms, run_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, NULL, 0, 0, ?, ?)`)
        .run(row.id, row.requesterKey, row.requesterLabel, row.agentName, row.source, row.projectId, row.agentId,
          row.projectFolder, row.title, row.what, JSON.stringify(row.requesterAreas), row.mode, row.at, row.at);
      this.event(row.id, { from: null, to: 'received', by: 'requester', at: row.at });
    },

    get(id) {
      if (!store.readable) return null;
      const row = db().prepare('SELECT * FROM visit_requests WHERE id = ?').get(id);
      return row ? requestView(row) : null;
    },

    // Moves one request from one of the expected states to another, with its
    // event, and sets the given fields; answers the row as it is now, or null
    // when it was not in any expected state (somebody else moved it first).
    move(id, { from, to, by, fields = {}, rule = null, checks = null, note = null, at }) {
      const columns = Object.entries(fields).map(([field]) => `${COLUMNS[field]} = ?`);
      const values = Object.entries(fields).map(([field, value]) => stored(field, value));
      const expected = Array.isArray(from) ? from : [from];
      const before = db().prepare('SELECT state FROM visit_requests WHERE id = ?').get(id)?.state;
      if (!before || !expected.includes(before)) return null;
      db().prepare(`UPDATE visit_requests SET state = ?, ${[...columns, 'updated_at = ?'].join(', ')} WHERE id = ? AND state = ?`)
        .run(to, ...values, at, id, before);
      this.event(id, { from: before, to, by, rule, checks, note, at });
      return this.get(id);
    },

    // Sets fields without a change of state (the plan as it arrives, the worktree once made).
    update(id, fields, at) {
      const columns = Object.keys(fields).map((field) => `${COLUMNS[field]} = ?`);
      db().prepare(`UPDATE visit_requests SET ${[...columns, 'updated_at = ?'].join(', ')} WHERE id = ?`)
        .run(...Object.entries(fields).map(([field, value]) => stored(field, value)), at, id);
    },

    // A note on the request's history without a change of state (an envelope decision that kept it where it is).
    event(id, { from, to, by, rule = null, checks = null, note = null, at }) {
      db().prepare(`INSERT INTO visit_request_events(request_id, from_state, to_state, by, rule, checks_json, note, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, from, to, by, rule, checks ? JSON.stringify(checks) : null, note, at);
    },

    events(id) {
      if (!store.readable) return [];
      return db().prepare('SELECT * FROM visit_request_events WHERE request_id = ? ORDER BY id LIMIT ?')
        .all(id, EVENTS_PER_REQUEST).map(eventView);
    },

    // Newest first; state narrows to one state.
    list({ state = null, limit }) {
      if (!store.readable) return [];
      return db().prepare(`SELECT * FROM visit_requests WHERE (? IS NULL OR state = ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(state, state, limit).map(requestView);
    },

    count(state) {
      if (!store.readable) return 0;
      return db().prepare('SELECT COUNT(*) AS count FROM visit_requests WHERE state = ?').get(state).count;
    },

    inStates(states, { requesterKey = null } = {}) {
      if (!store.readable) return [];
      return db().prepare(`SELECT * FROM visit_requests WHERE state IN (${states.map(() => '?').join(', ')})
        AND (? IS NULL OR requester_key = ?) ORDER BY created_at`).all(...states, requesterKey, requesterKey).map(requestView);
    },

    // Requests whose run's client process was not confirmed to have ended, or
    // whose worktree removal failed and is tried again (service.js runExit).
    unfinishedRuns() {
      if (!store.readable) return [];
      return db().prepare(`SELECT * FROM visit_requests WHERE run_exit IN ('unconfirmed', 'cleanup_pending') ORDER BY created_at`)
        .all().map(requestView);
    },

    // Requests this computer took (not refused) since an ISO instant, of one project or of all.
    acceptedSince(since, { projectId = null } = {}) {
      if (!store.readable) return 0;
      return db().prepare(`SELECT COUNT(*) AS count FROM visit_requests WHERE state <> 'refused' AND created_at > ?
        AND (? IS NULL OR project_id = ?)`).get(since, projectId, projectId).count;
    },

    // What one requester used since an ISO instant: requests that were taken
    // (not refused, and not failed before the run started for a reason on
    // this computer's side, NOT_STARTED_HERE), the ones still open, and the
    // minutes of wakes they cost. run_ms is 0 only when the client run never
    // began (the runner records at least 1 ms for any run that did).
    usage(requesterKey, since) {
      if (!store.readable) return { requests: 0, open: 0, wakeMs: 0, refused: 0 };
      const row = db().prepare(`SELECT
          SUM(CASE WHEN state <> 'refused' AND NOT (state = 'failed' AND run_ms = 0 AND COALESCE(error, '') IN (${NOT_STARTED_HERE.map(() => '?').join(', ')}))
            AND created_at > ? THEN 1 ELSE 0 END) AS requests,
          SUM(CASE WHEN state IN (${HELD_OPEN_STATES.map(() => '?').join(', ')}) THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN created_at > ? THEN planning_ms + run_ms ELSE 0 END) AS wake_ms,
          SUM(CASE WHEN state = 'refused' AND created_at > ? THEN 1 ELSE 0 END) AS refused
        FROM visit_requests WHERE requester_key = ?`).get(...NOT_STARTED_HERE, since, ...HELD_OPEN_STATES, since, since, requesterKey);
      return { requests: row.requests ?? 0, open: row.open ?? 0, wakeMs: row.wake_ms ?? 0, refused: row.refused ?? 0 };
    }
  };
}

// Why a request can fail on this computer before its run starts: nothing the
// requester did. Such a request is not counted among the requester's of the day.
const NOT_STARTED_HERE = Object.freeze(['no_repository', 'git_failed', 'no_constrained_client', 'no_working_directory']);

const COLUMNS = Object.freeze({
  plan: 'plan_json', planError: 'plan_error', review: 'review', holdReason: 'hold_reason', modeAtDecision: 'mode_at_decision',
  decidedBy: 'decided_by', reason: 'reason', branch: 'branch', worktreePath: 'worktree_path', baseCommit: 'base_commit',
  projectFolder: 'project_folder', summary: 'result_summary', files: 'files_json', diffstat: 'diffstat_json',
  planningMs: 'planning_ms', runMs: 'run_ms', error: 'error', heldPaths: 'held_paths_json', rootIdentity: 'root_identity',
  runPid: 'run_pid', runPidIdentity: 'run_pid_identity', runExit: 'run_exit'
});
const JSON_FIELDS = new Set(['plan', 'files', 'diffstat', 'heldPaths']);
const stored = (field, value) => (JSON_FIELDS.has(field) && value !== null ? JSON.stringify(value) : value);
const parsed = (text) => (text === null ? null : JSON.parse(text));

function requestView(row) {
  return { id: row.id, requesterKey: row.requester_key, requesterLabel: row.requester_label, agentName: row.agent_name,
    source: row.source, projectId: row.project_id, agentId: row.agent_id, projectFolder: row.project_folder,
    title: row.title, what: row.what, requesterAreas: JSON.parse(row.requester_areas_json), plan: parsed(row.plan_json),
    planError: row.plan_error, state: row.state, review: row.review, holdReason: row.hold_reason, heldPaths: parsed(row.held_paths_json),
    modeAtReceipt: row.mode_at_receipt, modeAtDecision: row.mode_at_decision, decidedBy: row.decided_by, reason: row.reason,
    branch: row.branch, worktreePath: row.worktree_path, baseCommit: row.base_commit, summary: row.result_summary,
    files: parsed(row.files_json), diffstat: parsed(row.diffstat_json), planningMs: row.planning_ms, runMs: row.run_ms,
    error: row.error, rootIdentity: row.root_identity, runPid: row.run_pid === null ? null : Number(row.run_pid),
    runPidIdentity: row.run_pid_identity, runExit: row.run_exit, createdAt: row.created_at, updatedAt: row.updated_at };
}

function eventView(row) {
  return { from: row.from_state, to: row.to_state, by: row.by, rule: row.rule, checks: parsed(row.checks_json),
    note: row.note, at: row.at };
}
