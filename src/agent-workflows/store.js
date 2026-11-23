import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, openReadOnly, sqliteFormat, userVersion } from '../../packages/roundtable/src/storage/database-format.js';

// An Agent's own workflows (rec#60 D-78): the repeated work it does, as named
// ordered steps. agent_workflows holds each workflow's current state: which
// version is active (the person confirmed it) and which one waits for the
// person's answer. Every change is a new row in agent_workflow_versions, its
// first proposal included; versions, the person's decisions and recorded runs
// are immutable (triggers refuse UPDATE and DELETE), so a workflow can always
// be read back to what was proposed, by whom, and what the person decided.
// A retired workflow keeps every row; nothing is ever deleted.
// A repeat the FLA has not deposited yet (Jevons 11-23): one row per repeated
// kind of work or workflow, found by the hourly check (fla-growth/tool-suggestions.js).
// It holds the steps that stand for it, the request the person was asked
// (its id and the wording it was asked in, so a changed wording cancels the
// old request first), the person's answer, how often the FLA's entry showed
// it, and what the FLA deposited for it (a workflow, or an Agent app) so a
// rejected proposal can give the repeat back. Detected state, not history:
// a row is updated in place.
const AGENT_GROWTH_HINTS = `
  CREATE TABLE IF NOT EXISTS agent_growth_hints(
    hint_key TEXT PRIMARY KEY, personal_space_id TEXT NOT NULL, agent_id TEXT NOT NULL, personal_project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('steps', 'workflow')), name TEXT NOT NULL, steps TEXT NOT NULL, task_count INTEGER NOT NULL,
    detected_at TEXT NOT NULL, shown_count INTEGER NOT NULL DEFAULT 0, shown_at TEXT,
    request_id TEXT, request_wording TEXT, answer TEXT CHECK(answer IN ('script', 'steps', 'no')),
    deposited_at TEXT, deposited_by TEXT);
  CREATE INDEX IF NOT EXISTS agent_growth_hints_owner ON agent_growth_hints(personal_space_id, agent_id, personal_project_id);`;

export const AGENT_WORKFLOWS_FORMAT = sqliteFormat({
  store: 'agent-workflows',
  schema: `
    CREATE TABLE IF NOT EXISTS agent_workflows(
      workflow_id TEXT PRIMARY KEY, personal_space_id TEXT NOT NULL, agent_id TEXT NOT NULL, personal_project_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('proposed', 'active', 'retired')),
      latest_version INTEGER NOT NULL, active_version INTEGER, pending_version INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_workflows_owner ON agent_workflows(personal_space_id, agent_id);
    CREATE TABLE IF NOT EXISTS agent_workflow_versions(
      workflow_id TEXT NOT NULL REFERENCES agent_workflows(workflow_id), version INTEGER NOT NULL,
      name TEXT NOT NULL, purpose TEXT NOT NULL, steps TEXT NOT NULL, source TEXT NOT NULL,
      created_by TEXT NOT NULL CHECK(created_by IN ('agent', 'person')), created_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, version));
    CREATE TABLE IF NOT EXISTS agent_workflow_decisions(
      workflow_id TEXT NOT NULL REFERENCES agent_workflows(workflow_id), version INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('confirm', 'reject', 'retire')),
      decided_by TEXT NOT NULL CHECK(decided_by IN ('person')), decided_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_workflow_decisions_workflow ON agent_workflow_decisions(workflow_id);
    CREATE TABLE IF NOT EXISTS agent_workflow_runs(
      run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES agent_workflows(workflow_id),
      version INTEGER NOT NULL, task_id TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('done', 'stopped', 'failed')), note TEXT, recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_workflow_runs_workflow ON agent_workflow_runs(workflow_id, recorded_at);
    CREATE TRIGGER IF NOT EXISTS agent_workflow_versions_no_update BEFORE UPDATE ON agent_workflow_versions
      BEGIN SELECT RAISE(ABORT, 'agent workflow versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_workflow_versions_no_delete BEFORE DELETE ON agent_workflow_versions
      BEGIN SELECT RAISE(ABORT, 'agent workflow versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_workflow_decisions_no_update BEFORE UPDATE ON agent_workflow_decisions
      BEGIN SELECT RAISE(ABORT, 'agent workflow decisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_workflow_decisions_no_delete BEFORE DELETE ON agent_workflow_decisions
      BEGIN SELECT RAISE(ABORT, 'agent workflow decisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_workflow_runs_no_update BEFORE UPDATE ON agent_workflow_runs
      BEGIN SELECT RAISE(ABORT, 'agent workflow runs are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_workflow_runs_no_delete BEFORE DELETE ON agent_workflow_runs
      BEGIN SELECT RAISE(ABORT, 'agent workflow runs are immutable'); END;`,
  migrations: [{
    // A Skill drafted from kept experiences starts with its work map (rec#78, 11-06
    // addition 5); versions proposed before it, and other proposals, keep NULL.
    id: 'agent-workflows/2-work-map', to: 2, kind: 'add-columns', table: 'agent_workflow_versions',
    summary: 'the work map (inputs, outputs, dependencies, branches, acceptance, questions) a version starts with',
    columns: { work_map: 'TEXT' }
  }, {
    id: 'agent-workflows/3-growth-hints', to: 3, kind: 'add-table', table: 'agent_growth_hints',
    summary: 'repeats an FLA has not deposited yet: their steps, the request the person was asked and its answer, how often the entry showed each, and what was deposited for it',
    create: AGENT_GROWTH_HINTS
  }]
});

const AGENT_WORKFLOWS_VERSION = AGENT_WORKFLOWS_FORMAT.version;

export class AgentWorkflowStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on the first write; a missing file reads as no workflows and is never created by a read.
  get db() {
    this.database ??= openFormattedDatabase(this.path, AGENT_WORKFLOWS_FORMAT);
    return this.database;
  }

  get readable() {
    return Boolean(this.database) || this.path === ':memory:' || existsSync(this.path);
  }

  // Readable now without a format step: a task entry never pays for a
  // migration (its backup runs a child process); the hourly check or the
  // console takes it, and the entry reads on after that.
  get current() {
    if (this.database || this.path === ':memory:') return true;
    if (!existsSync(this.path)) return false;
    const probe = openReadOnly(this.path);
    try { return userVersion(probe) === AGENT_WORKFLOWS_VERSION; }
    finally { probe.close(); }
  }

  transaction(work) {
    return immediateTransaction(this.db, work);
  }

  get(workflowId) {
    if (!this.readable) return null;
    return workflowView(this.db.prepare('SELECT * FROM agent_workflows WHERE workflow_id = ?').get(workflowId));
  }

  listForAgent(personalSpaceId, agentId) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM agent_workflows WHERE personal_space_id = ? AND agent_id = ?
      ORDER BY created_at, workflow_id`).all(personalSpaceId, agentId).map(workflowView);
  }

  listForSpace(personalSpaceId) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM agent_workflows WHERE personal_space_id = ?
      ORDER BY created_at, workflow_id`).all(personalSpaceId).map(workflowView);
  }

  // The Agent's workflow a set of kept experiences was first proposed from, if any.
  fromSource(personalSpaceId, agentId, source) {
    if (!this.readable) return null;
    return workflowView(this.db.prepare(`SELECT w.* FROM agent_workflows w JOIN agent_workflow_versions v
      ON v.workflow_id = w.workflow_id WHERE w.personal_space_id = ? AND w.agent_id = ? AND v.source = ?
      ORDER BY v.created_at LIMIT 1`).get(personalSpaceId, agentId, source));
  }

  version(workflowId, version) {
    if (!this.readable || !version) return null;
    return versionView(this.db.prepare('SELECT * FROM agent_workflow_versions WHERE workflow_id = ? AND version = ?')
      .get(workflowId, version));
  }

  // The newest runs first.
  runs(workflowId, limit) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM agent_workflow_runs WHERE workflow_id = ?
      ORDER BY recorded_at DESC, rowid DESC LIMIT ?`).all(workflowId, limit).map(runView);
  }

  // Writes a workflow's new current state, inside the caller's transaction.
  save(workflow) {
    this.db.prepare(`INSERT INTO agent_workflows VALUES(:workflow_id, :personal_space_id, :agent_id,
        :personal_project_id, :status, :latest_version, :active_version, :pending_version, :created_at, :updated_at)
      ON CONFLICT(workflow_id) DO UPDATE SET status = excluded.status, latest_version = excluded.latest_version,
        active_version = excluded.active_version, pending_version = excluded.pending_version,
        updated_at = excluded.updated_at`).run({
      workflow_id: workflow.workflowId, personal_space_id: workflow.personalSpaceId, agent_id: workflow.agentId,
      personal_project_id: workflow.personalProjectId, status: workflow.status,
      latest_version: workflow.latestVersion, active_version: workflow.activeVersion,
      pending_version: workflow.pendingVersion, created_at: workflow.createdAt, updated_at: workflow.updatedAt });
  }

  addVersion(record) {
    this.db.prepare(`INSERT INTO agent_workflow_versions(workflow_id, version, name, purpose, steps, source, created_by,
      created_at, work_map) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.workflowId, record.version, record.name,
      record.purpose, JSON.stringify(record.steps), record.source, record.createdBy, record.createdAt,
      record.workMap ? JSON.stringify(record.workMap) : null);
  }

  addDecision({ workflowId, version, decision, decidedAt }) {
    this.db.prepare('INSERT INTO agent_workflow_decisions VALUES(?, ?, ?, ?, ?)')
      .run(workflowId, version, decision, 'person', decidedAt);
  }

  addRun(run) {
    this.db.prepare('INSERT INTO agent_workflow_runs VALUES(?, ?, ?, ?, ?, ?, ?)').run(run.runId, run.workflowId,
      run.version, run.taskId, run.outcome, run.note, run.recordedAt);
  }

  // Found again by a later check: the steps that stand for it and every answer are kept.
  noteRepeat(hint) {
    this.db.prepare(`INSERT INTO agent_growth_hints(hint_key, personal_space_id, agent_id, personal_project_id, kind, name,
        steps, task_count, detected_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hint_key) DO UPDATE SET task_count = MAX(task_count, excluded.task_count)`).run(hint.key,
      hint.personalSpaceId, hint.agentId, hint.personalProjectId, hint.kind, hint.name, JSON.stringify(hint.steps),
      hint.taskCount, hint.detectedAt);
    return this.hint(hint.key);
  }

  hint(hintKey) {
    if (!this.readable) return null;
    return hintView(this.db.prepare('SELECT * FROM agent_growth_hints WHERE hint_key = ?').get(hintKey));
  }

  // Repeats the person was asked about and has not answered, and nothing was deposited for.
  awaitingAnswer(personalSpaceId) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM agent_growth_hints WHERE personal_space_id = ? AND request_id IS NOT NULL
      AND answer IS NULL AND deposited_at IS NULL ORDER BY detected_at, hint_key`).all(personalSpaceId).map(hintView);
  }

  // Undeposited repeats of one FLA, in one project or (null) in every one.
  openHints({ personalSpaceId, agentId, personalProjectId = null }) {
    if (!this.readable) return [];
    return this.db.prepare(`SELECT * FROM agent_growth_hints WHERE personal_space_id = ? AND agent_id = ?
      AND (? IS NULL OR personal_project_id = ?) AND deposited_at IS NULL ORDER BY detected_at, hint_key`)
      .all(personalSpaceId, agentId, personalProjectId, personalProjectId).map(hintView);
  }

  // Whether a repeat already stands on this request (an answer is used for one repeat only).
  requestUsed(requestId) {
    if (!this.readable) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM agent_growth_hints WHERE request_id = ? LIMIT 1').get(requestId));
  }

  recordRequest(hintKey, requestId, wording) {
    this.db.prepare('UPDATE agent_growth_hints SET request_id = ?, request_wording = ? WHERE hint_key = ?').run(requestId, wording, hintKey);
  }

  // The person's answer starts the FLA's reminders over: it now has their decision to act on.
  recordAnswer(hintKey, answer) {
    this.db.prepare('UPDATE agent_growth_hints SET answer = ?, shown_count = 0 WHERE hint_key = ?').run(answer, hintKey);
  }

  // The oldest repeat still owed to this FLA in this project, or null. The person's "no" ends it.
  nextHint({ personalSpaceId, agentId, personalProjectId }, maxShown) {
    if (!this.readable) return null;
    return hintView(this.db.prepare(`SELECT * FROM agent_growth_hints WHERE personal_space_id = ? AND agent_id = ?
      AND personal_project_id = ? AND deposited_at IS NULL AND (answer IS NULL OR answer <> 'no') AND shown_count < ?
      ORDER BY detected_at, hint_key LIMIT 1`).get(personalSpaceId, agentId, personalProjectId, maxShown));
  }

  markShown(hintKey, at) {
    this.db.prepare('UPDATE agent_growth_hints SET shown_count = shown_count + 1, shown_at = ? WHERE hint_key = ?').run(at, hintKey);
  }

  deposit(hintKey, by, at) {
    this.db.prepare('UPDATE agent_growth_hints SET deposited_at = ?, deposited_by = ? WHERE hint_key = ? AND deposited_at IS NULL')
      .run(at, by, hintKey);
  }

  // A proposal the person turned down gives its repeats back.
  undeposit(by) {
    this.db.prepare('UPDATE agent_growth_hints SET deposited_at = NULL, deposited_by = NULL WHERE deposited_by = ?').run(by);
  }

  // How often each workflow was run, and how often it ran through: counted, not sampled.
  runCounts(workflowId) {
    if (!this.readable) return { runCount: 0, doneCount: 0 };
    const row = this.db.prepare(`SELECT COUNT(*) AS runs, SUM(outcome = 'done') AS done FROM agent_workflow_runs
      WHERE workflow_id = ?`).get(workflowId);
    return { runCount: Number(row?.runs ?? 0), doneCount: Number(row?.done ?? 0) };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function workflowView(row) {
  if (!row) return null;
  return { workflowId: row.workflow_id, personalSpaceId: row.personal_space_id, agentId: row.agent_id,
    personalProjectId: row.personal_project_id, status: row.status, latestVersion: row.latest_version,
    activeVersion: row.active_version, pendingVersion: row.pending_version, createdAt: row.created_at,
    updatedAt: row.updated_at };
}

function versionView(row) {
  if (!row) return null;
  return { workflowId: row.workflow_id, version: row.version, name: row.name, purpose: row.purpose,
    steps: JSON.parse(row.steps), ...(row.work_map ? { workMap: JSON.parse(row.work_map) } : {}), source: row.source,
    createdBy: row.created_by, createdAt: row.created_at };
}

function hintView(row) {
  if (!row) return null;
  return { key: row.hint_key, personalSpaceId: row.personal_space_id, agentId: row.agent_id,
    personalProjectId: row.personal_project_id, kind: row.kind, name: row.name, steps: JSON.parse(row.steps),
    taskCount: row.task_count, detectedAt: row.detected_at, shownCount: row.shown_count, requestId: row.request_id,
    requestWording: row.request_wording, answer: row.answer, depositedAt: row.deposited_at, depositedBy: row.deposited_by };
}

function runView(row) {
  return { runId: row.run_id, workflowId: row.workflow_id, version: row.version, taskId: row.task_id,
    outcome: row.outcome, note: row.note, recordedAt: row.recorded_at };
}
