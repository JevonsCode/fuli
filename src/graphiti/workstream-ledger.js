// The ledger of a project's workstreams (docs/workstreams.md). One line of
// work answers four things in one place: which project, which line, who, and
// how far. The first three are the standing assignment itself; the fourth is
// its owner's latest task in that project, read only when the caller asks for
// it, never at task entry.

const LATEST_TASKS = 1;

/**
 * A project's lines of work, newest last. A workstream is a standing
 * assignment of this project whose Agent is not its lead: one pointing at the
 * lead routes work into the project rather than dividing work inside it. An
 * owner that has left keeps its ID, so the person can still move or end it.
 */
export function projectWorkstreams(assignments, projectId, leadAgentId, people = new Map()) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter(item => item.projectId === projectId && !item.retiredAt && item.leadAgentId !== leadAgentId)
    .map(item => ({
      assignmentId: item.assignmentId,
      name: item.responsibility,
      terms: [...item.terms],
      ownerAgentId: item.leadAgentId,
      ownerName: people.get(item.leadAgentId)?.name ?? null,
      ownerOnProject: people.has(item.leadAgentId),
      decidedBy: item.source,
      startedAt: item.createdAt,
      changedAt: item.updatedAt,
      revision: item.revision
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
      || left.assignmentId.localeCompare(right.assignmentId));
}

/**
 * The same lines with how far each one got: its owner's latest task in this
 * project, as the task list already reports it. One bounded read per line, all
 * at once; a read that fails leaves that line's `latestTask` null rather than
 * failing the ledger.
 */
export async function withWorkstreamProgress(application, personalSpaceId, personalProjectId, lines) {
  if (!lines.length) return lines;
  const reads = await Promise.allSettled(lines.map(line => application.personal.listProjectAgentTasks({
    personalSpaceId, personalProjectId, agentId: line.ownerAgentId, limit: LATEST_TASKS
  })));
  return lines.map((line, index) => ({ ...line, latestTask: latestTask(reads[index]) }));
}

function latestTask(read) {
  const task = read.status === 'fulfilled' && Array.isArray(read.value) ? read.value[0] : null;
  if (!task?.task_id) return null;
  return { taskId: task.task_id, title: task.title ?? null, status: task.status ?? null,
    updatedAt: task.updated_at ?? null };
}
