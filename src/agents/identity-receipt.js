import { sourceConsoleUrl } from '../graphiti/source-marker.js';

export function agentProfileUrl(application, agentId) {
  return `${application.consoleUrl ?? sourceConsoleUrl(null)}/agents/${encodeURIComponent(application.config.personal.spaceId)}/${encodeURIComponent(agentId)}`;
}

export function agentContinuation(projectId, agentId, conversationId = null) {
  return { personal_project_id: projectId, agent_id: agentId,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    prompt: `@{${encodeURIComponent(agentId)}} 请在 FULI 项目 ${JSON.stringify(projectId)} 对应的工作目录继续工作。`
      + (conversationId ? `先用当前任务的 taskContextToken 调用 resume_agent_conversation，conversationId=${JSON.stringify(conversationId)}，再按需读取上下文。` : '先恢复这个 Agent 的项目记忆和最近会话。'),
    guidance: 'Use a connected client and the same authorized project/Agent. Obtain a fresh task context; never reuse the previous client’s token. This is a FULI prompt, not a native client @ picker registration.' };
}

export function taskAgentReceipt(application, { projectId, agentId, name = null,
  sourceApplication = null, workStatus = null, conversationId = null, persistence = null }) {
  return { owner: { agent_id: agentId, name,
    profile_url: agentProfileUrl(application, agentId), source_application: sourceApplication },
    personal_project_id: projectId, work_status: workStatus, persistence,
    continuation: agentContinuation(projectId, agentId, conversationId),
    guidance: 'Finish with the named owner and profile link, truthful work/memory status and continuation. Add only actually used collaboration_receipt participants (for example Jefa); tools and configured peers are not independent model workers.' };
}

export function employeeCollaborationReceipt(application, context, { tool, permission, sourceApplication }) {
  return { agent_id: context.agentId, name: context.name, role: context.role,
    profile_url: agentProfileUrl(application, context.agentId),
    personal_project_id: context.project.id, tool, permission,
    status: 'tool_completed', source_application: sourceApplication ?? 'other', worker_started: false };
}
