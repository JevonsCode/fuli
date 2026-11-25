import { singleLineExcerpt } from '../text/single-line.js';

// The sender's own finished work in one project, as a bounded index for the
// FLA that takes over. A handoff is about what the outgoing Agent did, so this
// reads only that Agent's task records in the same project: never another
// Agent's private memory, never a roundtable message body and never a session
// transcript. The caller binds it to one ask; the recipient reads it from the
// ask, so nothing here needs the recipient's identity.
export const HANDOFF_LIMIT = 10;
const COMPLETED_LIMIT = 3;
const REMAINING_LIMIT = 3;
const TASK_READ_LIMIT = 30;
const TITLE_CHARS = 300;
const SUMMARY_CHARS = 600;
const EVIDENCE_CHARS = 400;
// A task is still the sender's open work until one of these ends it.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped']);

// { completed, remaining, omitted } or null when neither source could be read
// or the sender has no recent finished work. bound means the caller named the
// task explicitly: an unreadable, foreign or non-completed task is then not
// replaced by other work, so the handoff never substitutes unrelated evidence.
export async function roundtableHandoff(application, { agentId, projectId, taskId = null, bound = false,
  since, until, limit = HANDOFF_LIMIT } = {}) {
  if (!application || !agentId || !projectId || typeof since !== 'string') return null;
  const boundary = Date.parse(since);
  const ceiling = Date.parse(until);
  if (!Number.isFinite(boundary) || !Number.isFinite(ceiling)) return null;
  const personalSpaceId = application.config?.personal?.spaceId;
  if (!personalSpaceId) return null;
  const named = taskId ? await readOne(application, { personalSpaceId, projectId, agentId, taskId }) : null;
  // A task the caller named must be readable, in this project and the sender's.
  if (bound && taskId && !named) return null;
  if (bound && named && TERMINAL.has(named.status) && named.status !== 'completed') return null;
  const listed = await readList(application, { personalSpaceId, projectId, agentId });
  const tasks = mergeTasks([...(named ? [named] : []), ...(listed ?? [])])
    // The list is asked for one project, but a record still has to prove it
    // belongs there: another project's task is never this sender's handoff.
    .filter(task => task.personalProjectId === projectId);
  const inWindow = task => {
    const at = Date.parse(taskAt(task));
    return Number.isFinite(at) && at >= boundary && at <= ceiling;
  };
  const completedCandidates = tasks
    .filter(task => task.status === 'completed' && owns(task, agentId) && inWindow(task))
    .sort((left, right) => Date.parse(taskAt(right)) - Date.parse(taskAt(left)));
  const openCandidates = tasks
    .filter(task => !TERMINAL.has(task.status) && owns(task, agentId) && inWindow(task))
    .sort((left, right) => Date.parse(taskAt(right)) - Date.parse(taskAt(left)));
  const namedIsCompleted = Boolean(named && completedCandidates.some(task => sameTask(task, named)));
  // An explicitly named task is the work handed off. Without an explicit
  // binding, a named open task may stand on the sender's latest finished work.
  const chosen = namedIsCompleted
    ? completedCandidates.filter(task => sameTask(task, named))
    : bound ? [] : completedCandidates.slice(0, COMPLETED_LIMIT);
  // A bound open task is still the sender's work, so it is listed as remaining;
  // unrelated open tasks are not substituted for it.
  const remainingCandidates = bound && named && !TERMINAL.has(named.status)
    ? openCandidates.filter(task => sameTask(task, named))
    : openCandidates;
  const completed = chosen.slice(0, Math.max(1, Math.min(limit, COMPLETED_LIMIT))).map(completedRow);
  const remaining = remainingCandidates.slice(0, REMAINING_LIMIT);
  if (!completed.length && !remaining.length) return null;
  return { completed, remaining: remaining.map(openRow),
    // Only the sender's own work is counted, and every row the block could not
    // list is said rather than hidden.
    omitted: Math.max(0, completedCandidates.length - completed.length)
      + Math.max(0, openCandidates.length - remaining.length) };
}

async function readOne(application, { personalSpaceId, projectId, agentId, taskId }) {
  if (typeof application.viewProjectAgentTask !== 'function') return null;
  try {
    const task = await application.viewProjectAgentTask({ personalSpaceId, personalProjectId: projectId,
      taskId, includeEvents: false });
    // A task of another project or Agent is never this sender's handoff, and a
    // record that does not prove its project is not trusted.
    if (!task || task.personalProjectId !== projectId || !owns(task, agentId)) return null;
    return task;
  } catch { return null; }
}

async function readList(application, { personalSpaceId, projectId, agentId }) {
  if (typeof application.listProjectAgentTasks !== 'function') return null;
  try {
    const value = await application.listProjectAgentTasks({ personalSpaceId, personalProjectId: projectId,
      agentId, limit: TASK_READ_LIMIT });
    const tasks = Array.isArray(value) ? value : value?.tasks ?? value?.items ?? [];
    return tasks;
  } catch { return null; }
}

// The same task can arrive from the named read and the list; the first record wins.
function mergeTasks(tasks) {
  const byId = new Map();
  for (const task of tasks) if (task?.taskId && !byId.has(task.taskId)) byId.set(task.taskId, task);
  return [...byId.values()];
}

const sameTask = (task, other) => task.taskId === other.taskId;
const owns = (task, agentId) => task.leadAgentId === agentId
  || (task.participants ?? []).some(person => person.agentId === agentId);

// A finished task is placed by when it finished; an open one by when it moved.
function taskAt(task) {
  return TERMINAL.has(task.status)
    ? task.completedAt ?? task.updatedAt ?? task.createdAt
    : task.updatedAt ?? task.createdAt;
}

function completedRow(task) {
  return { taskId: task.taskId, title: singleLine(task.title, TITLE_CHARS),
    status: task.status, at: new Date(taskAt(task)).toISOString(),
    summary: singleLine(task.resultSummary ?? task.failureReason, SUMMARY_CHARS),
    evidence: evidenceOf(task), source: task.sourceApplication ?? null };
}

function openRow(task) {
  return { taskId: task.taskId, title: singleLine(task.title, TITLE_CHARS),
    status: task.status, at: new Date(taskAt(task)).toISOString() };
}

// What the task record itself proves about the work, kept short: a quality
// gate, the verified artifact revision and the run that produced it.
function evidenceOf(task) {
  const parts = [];
  if (task.qualityGate) parts.push(`quality gate ${singleLine(task.qualityGate, EVIDENCE_CHARS)}`);
  if (task.verifiedArtifactRevision) parts.push(`revision ${singleLine(task.verifiedArtifactRevision, EVIDENCE_CHARS)}`);
  if (task.runId) parts.push(`run ${singleLine(task.runId, EVIDENCE_CHARS)}`);
  return parts.length ? parts.join('；') : null;
}

function singleLine(value, limit) {
  return typeof value === 'string' ? singleLineExcerpt(value, limit) : null;
}
