// What an FLA's own task entry says about the work it keeps repeating
// (Jevons 11-23: an FLA that keeps doing a kind of work writes it down as a
// workflow; what it runs every time becomes a script). Two short parts, each
// present only when there is something to say, so an ordinary entry carries
// no extra key at all:
// - workflows: the names of its confirmed workflows in this project, on the
//   first turn of a conversation only; steps are read on demand.
// - repeated: a repeat the hourly check found that the FLA has not deposited,
//   at most twice; the tools it names and how to use them are in
//   task_guidance.self_deposit (fuli://rules/task-entry/task_guidance).
// Read from the local workflows store, model-free; never fails an entry.
export function flaGrowthEntry(application, task, { opensConversation = false } = {}) {
  if (!task?.projectAgentId || !task.personalProjectId || !application.agentWorkflows?.entryGrowth) return null;
  let growth;
  try {
    growth = application.agentWorkflows.entryGrowth({ personalSpaceId: application.config.personal.spaceId,
      agentId: task.projectAgentId, personalProjectId: task.personalProjectId }, { withWorkflows: opensConversation });
  } catch {
    return null;
  }
  const value = {
    ...(growth.workflows.length ? { workflows: growth.workflows } : {}),
    ...(growth.hint ? { repeated: repeatedLine(growth.hint) } : {})
  };
  return Object.keys(value).length ? value : null;
}

function repeatedLine(hint) {
  return hint.kind === 'workflow'
    ? `Your workflow "${hint.name}" ran through in ${hint.taskCount} tasks here: turn the commands it runs every time into a script (submit_agent_app_version).`
    : `You did the same ${hint.stepCount} steps ("${hint.name}" …) in ${hint.taskCount} tasks here: propose them as a workflow (propose_agent_workflow {name, purpose, steps}); a command repeated in them becomes a script (submit_agent_app_version).`;
}
