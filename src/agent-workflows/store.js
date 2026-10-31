import { existsSync } from 'node:fs';

import { openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';

// An Agent's own workflows (rec#60 D-78): the repeated work it does, as named
// ordered steps. agent_workflows holds each workflow's current state: which
// version is active (the person confirmed it) and which one waits for the
// person's answer. Every change is a new row in agent_workflow_versions, its
// first proposal included; versions, the person's decisions and recorded runs
// are immutable (triggers refuse UPDATE and DELETE), so a workflow can always
// be read back to what was proposed, by whom, and what the person decided.
// A retired workflow keeps every row; nothing is ever deleted.
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
      BEGIN SELECT RAISE(ABORT, 'agent workflow runs are immutable'); END;`
});

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

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  // The Agent's workflow a candidate was first proposed from, if any.
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
    this.db.prepare('INSERT INTO agent_workflow_versions VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(record.workflowId,
      record.version, record.name, record.purpose, JSON.stringify(record.steps), record.source, record.createdBy,
      record.createdAt);
  }

  addDecision({ workflowId, version, decision, decidedAt }) {
    this.db.prepare('INSERT INTO agent_workflow_decisions VALUES(?, ?, ?, ?, ?)')
      .run(workflowId, version, decision, 'person', decidedAt);
  }

  addRun(run) {
    this.db.prepare('INSERT INTO agent_workflow_runs VALUES(?, ?, ?, ?, ?, ?, ?)').run(run.runId, run.workflowId,
      run.version, run.taskId, run.outcome, run.note, run.recordedAt);
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
    steps: JSON.parse(row.steps), source: row.source, createdBy: row.created_by, createdAt: row.created_at };
}

function runView(row) {
  return { runId: row.run_id, workflowId: row.workflow_id, version: row.version, taskId: row.task_id,
    outcome: row.outcome, note: row.note, recordedAt: row.recorded_at };
}
