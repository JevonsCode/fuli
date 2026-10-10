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

function agentLink(application, agentId, name) {
  const label = String(name?.trim() || agentId).replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()!|]/g, '\\$&');
  return `[${label}](<${agentProfileUrl(application, agentId).replace(/[<>\s]/g, encodeURIComponent)}>)`;
}

// The reply's attribution line: who led the task and who actually helped.
export function taskAgentReceipt(application, { projectId, agentId, name = null,
  sourceApplication = null, workStatus = null, conversationId = null, persistence = null,
  collaborators = [], assignmentStatus = null, assignmentReason = null }) {
  const owner = agentId ? { agent_id: agentId, name,
    profile_url: agentProfileUrl(application, agentId), source_application: sourceApplication } : null;
  const helpers = owner ? collaborators.filter(item => item.agentId !== agentId) : [];
  const markdown = owner
    ? `FULI Agent：负责人 ${agentLink(application, agentId, name)}`
      + (helpers.length ? ` · 协作 ${helpers.map(item => agentLink(application, item.agentId, item.name)).join('、')}` : '')
    : unassignedReceipt(assignmentStatus, assignmentReason);
  return { required: true, markdown, owner,
    collaborators: helpers.map(item => ({ agent_id: item.agentId, name: item.name,
      profile_url: agentProfileUrl(application, item.agentId) })),
    personal_project_id: projectId, work_status: workStatus, persistence,
    continuation: owner ? agentContinuation(projectId, agentId, conversationId) : null,
    guidance: 'MUST end every final user-visible reply with agent_receipt.markdown unchanged, exactly once, including greetings, status and errors, even when capture is disabled or nothing is retained. The receipt returned by checkpoint_task_knowledge supersedes the entry receipt because it names actual collaborators. Never invent an owner or a collaborator.' };
}

function unassignedReceipt(status, reason) {
  if (!status) return 'FULI Agent：分配未完成（任务没有可用负责人）';
  if (status === 'project_unresolved') {
    return reason === 'ambiguous' ? 'FULI Agent：分配待确认（项目归属待确认）'
      : reason === 'session_identity_required' ? 'FULI Agent：分配失败（缺少会话标识）'
        : 'FULI Agent：分配失败（项目归属未能恢复）';
  }
  const labels = {
    unavailable: '分配失败（服务或身份恢复不可用）',
    agent_unavailable: '分配失败（指定 FLA 不可用）',
    agent_not_found: '分配失败（指定 FLA 不存在）',
    ambiguous_agent: '分配待确认（存在同名 FLA）',
    agent_selection_conflict: '分配待确认（FLA 选择冲突）',
    manual_selection: '分配待确认（需要选择负责人）'
  };
  return `FULI Agent：${labels[status] ?? '分配未完成（AR 尚未返回负责人）'}`;
}

export function employeeCollaborationReceipt(application, context, { tool, permission, sourceApplication }) {
  return { agent_id: context.agentId, name: context.name, role: context.role,
    profile_url: agentProfileUrl(application, context.agentId),
    personal_project_id: context.project.id, tool, permission,
    status: 'tool_completed', source_application: sourceApplication ?? 'other', worker_started: false };
}
