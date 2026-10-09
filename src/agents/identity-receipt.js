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
  const owner = agentId ? { agent_id: agentId, name,
    profile_url: agentProfileUrl(application, agentId), source_application: sourceApplication } : null;
  const label = String(name?.trim() || agentId).replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()!|]/g, '\\$&');
  const markdown = owner
    ? `FULI Agent：[${label}](<${owner.profile_url.replace(/[<>\s]/g, encodeURIComponent)}>)`
    : 'FULI Agent：未选定';
  return { required: true, markdown, owner,
    personal_project_id: projectId, work_status: workStatus, persistence,
    continuation: owner ? agentContinuation(projectId, agentId, conversationId) : null,
    guidance: 'MUST include agent_receipt.markdown unchanged exactly once in every final user-visible reply, including greetings, status and errors, even when capture is disabled or nothing is retained. Use this task’s receipt; never invent an owner. Report only truthful work/memory status and actually used collaboration_receipt participants; tools and configured peers are not independent model workers.' };
}

export function employeeCollaborationReceipt(application, context, { tool, permission, sourceApplication }) {
  return { agent_id: context.agentId, name: context.name, role: context.role,
    profile_url: agentProfileUrl(application, context.agentId),
    personal_project_id: context.project.id, tool, permission,
    status: 'tool_completed', source_application: sourceApplication ?? 'other', worker_started: false };
}
