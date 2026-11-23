// What an FLA's own task entry says about the work it keeps repeating
// (Jevons 11-23: an FLA that keeps doing a kind of work writes it down as a
// workflow; what it runs every time becomes a script). Only on the first turn
// of a conversation, so the reminders are counted per conversation and a
// string of short messages cannot use them up. Two parts, each present only
// when there is something to say, so an ordinary entry carries no extra key:
// - workflows: its confirmed workflows in this project, a name and one
//   sentence each; steps are read on demand;
// - repeated: a repeat the hourly check found that it has not deposited, with
//   the person's answer when there is one, at most twice per answer.
// The full rule is task_guidance.self_deposit (fuli://rules/task-entry/task_guidance).
// Read from the local workflows store, model-free; never fails an entry.
export function flaGrowthEntry(application, task, { opensConversation = false } = {}) {
  if (!opensConversation || !task?.projectAgentId || !task.personalProjectId || !application.agentWorkflows?.entryGrowth) return null;
  let growth;
  try {
    growth = application.agentWorkflows.entryGrowth({ personalSpaceId: application.config.personal.spaceId,
      agentId: task.projectAgentId, personalProjectId: task.personalProjectId });
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
  const work = `"${hint.name}" (${hint.taskCount} tasks here)`;
  if (hint.answer === 'script') {
    return `The person chose a script for ${work}: submit it as an Agent app with submit_agent_app_version `
      + '(runtime.entry, not resident, no keys or tokens in its files); they confirm it in the terminal from Agents → Apps.';
  }
  if (hint.answer === 'steps') {
    return `The person chose to keep ${work} as steps: propose them with propose_agent_workflow {name, purpose, steps}; `
      + 'their choice confirms it.';
  }
  return hint.kind === 'workflow'
    ? `Your workflow ${work} ran through each time: a command it runs every time can become a script (submit_agent_app_version).`
    : `You keep doing the same kind of work, ${work}: propose its steps as a workflow (propose_agent_workflow {name, purpose, steps}); `
      + 'a command repeated in it can become a script (submit_agent_app_version).';
}
