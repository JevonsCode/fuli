// Optional read-side delivery runs after the owned checkpoint is committed.
// It cannot undo that write, create approval, or start a judgment client.
export async function checkpointHumanInteraction(application, task) {
  const personalSpaceId = application.config.personal.spaceId;
  try {
    if (task.personalProjectId && task.projectAgentId && application.listAgentAttention) {
      const { human_interaction } = await application.listAgentAttention({ personalSpaceId,
        personalProjectId: task.personalProjectId, agentId: task.projectAgentId, status: 'open', limit: 1 });
      if (human_interaction) return { human_interaction };
    }
    // Tonborg's question as this task's reader may read it (rec#50).
    return await application.judgment?.agent?.conversationQuestions?.({ personalSpaceId,
      personalProjectId: task.personalProjectId ?? null, projectAgentId: task.projectAgentId ?? null }) ?? {};
  } catch {
    return { human_question_delivery: { status: 'unavailable', retry: 'list_agent_attention or list_judgments' } };
  }
}
