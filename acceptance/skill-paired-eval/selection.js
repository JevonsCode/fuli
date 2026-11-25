// Read-only selection of exactly one stored Agent workflow version
// (agent-workflows.sqlite, rec#60 D-78; drafted Skills rec#78). The runner
// never opens the store for writing: no proposal, decision or run is recorded,
// and a store an upgrade has not migrated yet is refused instead of migrated.
// The index is compact (no steps); steps are read only for the one version the
// person selected.
import { existsSync } from 'node:fs';

import { openReadOnly, userVersion } from '../../packages/roundtable/src/storage/database-format.js';
import { AGENT_WORKFLOWS_FORMAT } from '../../src/agent-workflows/store.js';

const FORMAT_VERSION = AGENT_WORKFLOWS_FORMAT.version;

function withStore(path, work) {
  if (!existsSync(path)) throw new Error(`No Agent workflow store at ${path}`);
  let database;
  try {
    database = openReadOnly(path);
    const found = userVersion(database);
    if (found !== FORMAT_VERSION) {
      throw new Error(`The workflow store is format ${found}; this evaluation reads format ${FORMAT_VERSION}. `
        + 'Open FULI once so its own migration runs, then try again. Nothing here changes the store.');
    }
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_workflows'").get()) {
      throw new Error(`${path} is not a FULI Agent workflow store`);
    }
    return work(database);
  } catch (error) {
    // openReadOnly refuses a write-ahead log that lost its index; say what to do.
    if (!database && /its write-ahead log has no index/.test(error.message)) {
      throw new Error(`Cannot read ${path} read-only: ${error.message}`);
    }
    throw error;
  } finally {
    database?.close();
  }
}

function stepCount(steps) {
  try {
    const parsed = JSON.parse(steps);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function jsonColumn(row, name, label, workflowId, version) {
  if (!row[name]) return undefined;
  try {
    return JSON.parse(row[name]);
  } catch {
    throw new Error(`Workflow ${workflowId} version ${version} has unreadable ${label}`);
  }
}

// The compact index a person chooses from: the workflow's current state and
// the name of the version it would use, never its steps.
export function listStoredWorkflows(path, { personalSpaceId = null, agentId = null } = {}) {
  return withStore(path, database => database.prepare(`
    SELECT w.workflow_id, w.personal_space_id, w.agent_id, w.personal_project_id, w.status,
      w.latest_version, w.active_version, w.pending_version, w.created_at, w.updated_at,
      v.version AS shown_version, v.name, v.purpose, v.steps, v.created_by
    FROM agent_workflows w
    JOIN agent_workflow_versions v ON v.workflow_id = w.workflow_id
      AND v.version = COALESCE(w.active_version, w.pending_version, w.latest_version)
    WHERE (? IS NULL OR w.personal_space_id = ?) AND (? IS NULL OR w.agent_id = ?)
    ORDER BY w.created_at, w.workflow_id`).all(personalSpaceId, personalSpaceId, agentId, agentId)
    .map(row => ({
      workflowId: row.workflow_id,
      personalSpaceId: row.personal_space_id,
      agentId: row.agent_id,
      personalProjectId: row.personal_project_id,
      status: row.status,
      latestVersion: row.latest_version,
      activeVersion: row.active_version,
      pendingVersion: row.pending_version,
      shownVersion: row.shown_version,
      name: row.name,
      purpose: row.purpose,
      stepCount: stepCount(row.steps),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })));
}

// The one version to evaluate, with its steps and the person's decision on it.
// By default the active version is selected (the only one FULI calls usable).
// An explicit version may be a stored draft; then active is false and the
// report says so, instead of pretending the person confirmed it.
export function readStoredWorkflow(path, workflowId, { version = null } = {}) {
  return withStore(path, database => {
    const workflow = database.prepare('SELECT * FROM agent_workflows WHERE workflow_id = ?').get(workflowId);
    if (!workflow) throw new Error(`No workflow ${workflowId} in ${path}`);
    const chosen = version ?? workflow.active_version;
    if (!chosen) throw new Error(`Workflow ${workflowId} has no active version; choose a stored version with --version`);
    const row = database.prepare('SELECT * FROM agent_workflow_versions WHERE workflow_id = ? AND version = ?')
      .get(workflowId, chosen);
    if (!row) throw new Error(`Workflow ${workflowId} has no version ${chosen}`);
    let steps;
    try { steps = JSON.parse(row.steps); } catch { throw new Error(`Workflow ${workflowId} version ${chosen} has unreadable steps`); }
    if (!Array.isArray(steps)) throw new Error(`Workflow ${workflowId} version ${chosen} has unreadable steps`);
    const workMap = jsonColumn(row, 'work_map', 'workMap', workflowId, chosen);
    const lesson = jsonColumn(row, 'lesson', 'lesson', workflowId, chosen);
    const approval = jsonColumn(row, 'approval', 'approval', workflowId, chosen);
    const decisions = database.prepare(`SELECT decision, decided_by, decided_at FROM agent_workflow_decisions
      WHERE workflow_id = ? AND version = ? ORDER BY rowid`).all(workflowId, chosen)
      .map(decision => ({ decision: decision.decision, decidedBy: decision.decided_by, decidedAt: decision.decided_at }));
    const confirmed = decisions.find(decision => decision.decision === 'confirm') ?? null;
    return {
      storePath: path,
      workflowId,
      version: chosen,
      selectionId: `${workflowId}@${chosen}`,
      name: row.name,
      purpose: row.purpose,
      steps,
      ...(workMap ? { workMap } : {}),
      ...(lesson ? { lesson } : {}),
      ...(approval ? { approval } : {}),
      source: row.source,
      createdBy: row.created_by,
      createdAt: row.created_at,
      status: workflow.status,
      personalSpaceId: workflow.personal_space_id,
      agentId: workflow.agent_id,
      personalProjectId: workflow.personal_project_id,
      latestVersion: workflow.latest_version,
      activeVersion: workflow.active_version,
      pendingVersion: workflow.pending_version,
      active: workflow.active_version === chosen,
      confirmed: Boolean(confirmed),
      confirmedBy: confirmed?.decidedBy ?? null,
      confirmedAt: confirmed?.decidedAt ?? null,
      decisions
    };
  });
}
