import { InvalidInputError } from '../app/application-error.js';
import { utf8Preview } from '../text/utf8-preview.js';

// What list_project_agent_tasks gives an Agent to triage tasks (rec#123): one
// line of facts per task, never its events or routing decision, which made a
// page of five tasks over 100 KB and the generic result cut drop fields and
// leave empty objects. view_project_agent_task reads one task in full.
const DEFAULT_LIMIT = 50;
// A page stops below the tool's 128 KiB result limit, so it is never cut; the
// cursor continues after the last task it holds.
const PAGE_BYTES = 96 * 1024;
const TITLE_BYTES = 200;
const TEXT_BYTES = 400;
const CURSOR_HINT = 'cursor must be the nextCursor of an earlier list_project_agent_tasks page';
const TASK_DETAIL_HINT = 'view_project_agent_task(taskId) reads one task with its events, routing and full text';

export async function listProjectAgentTaskSummaries(app, { cursor = null, limit = null, ...filters }) {
  const size = limit ?? DEFAULT_LIMIT;
  const after = cursor ? taskCursor(cursor) : null;
  // One more task than the page says whether another page follows.
  const tasks = await app.listProjectAgentTasks({ ...filters, limit: size + 1,
    afterUpdatedAt: after?.updatedAt ?? null, afterTaskId: after?.taskId ?? null });
  const page = [];
  let bytes = 0;
  for (const task of tasks.slice(0, size)) {
    const summary = taskSummary(task);
    const added = Buffer.byteLength(JSON.stringify(summary)) + 1;
    if (page.length && bytes + added > PAGE_BYTES) break;
    page.push(summary);
    bytes += added;
  }
  const last = page.at(-1);
  // A Provider that does not know the cursor answers with the first page again: stop there, never loop.
  const moved = !after || !page.length || Date.parse(page[0].updatedAt) < Date.parse(after.updatedAt)
    || (Date.parse(page[0].updatedAt) === Date.parse(after.updatedAt) && page[0].taskId !== after.taskId);
  return { tasks: page, nextCursor: moved && tasks.length > page.length && last ? encodeCursor(last) : null,
    detail: TASK_DETAIL_HINT };
}

function taskSummary(task) {
  return {
    taskId: task.taskId,
    personalProjectId: task.personalProjectId,
    ...(task.projectScope ? { projectScope: task.projectScope } : {}),
    title: bounded(task.title, TITLE_BYTES),
    status: task.status,
    revision: task.revision,
    workKind: task.workKind,
    leadAgentId: task.leadAgentId,
    participants: (task.participants ?? []).map(({ agentId, role, status }) => ({ agentId, role, status })),
    blocker: task.blocker ? { ...task.blocker, reason: bounded(task.blocker.reason, TEXT_BYTES) } : null,
    resultSummary: bounded(task.resultSummary, TEXT_BYTES),
    failureReason: bounded(task.failureReason, TEXT_BYTES),
    qualityGate: task.qualityGate,
    activityOrigin: task.activityOrigin,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt
  };
}

const bounded = (text, limit) => (typeof text === 'string' ? utf8Preview(text, limit) : text);

// The position after one listed task: the list's order is latest change first, then task ID.
function encodeCursor({ updatedAt, taskId }) {
  return Buffer.from(JSON.stringify([updatedAt, taskId])).toString('base64url');
}

function taskCursor(cursor) {
  let position;
  try {
    position = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new InvalidInputError(CURSOR_HINT);
  }
  const [updatedAt, taskId] = Array.isArray(position) ? position : [];
  if (!Array.isArray(position) || position.length !== 2 || typeof taskId !== 'string' || !taskId
    || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
    throw new InvalidInputError(CURSOR_HINT);
  }
  return { updatedAt, taskId };
}
