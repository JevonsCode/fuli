import { sourceConsoleUrl } from '../graphiti/source-marker.js';
import { agentLabel } from './agent-label.js';

// The console origin every receipt link opens.
export function receiptConsoleUrl(application) {
  return application.consoleUrl ?? sourceConsoleUrl(null);
}

// The settings page where the person turns recording back on (rec#5 C10-3).
export function captureSettingsUrl(application) {
  return `${receiptConsoleUrl(application)}/settings`;
}

export function agentProfileUrl(application, agentId) {
  return `${receiptConsoleUrl(application)}/agents/${encodeURIComponent(application.config.personal.spaceId)}/${encodeURIComponent(agentId)}`;
}

// One host session's record list (rec#5 C6), short because every saving
// turn's receipt carries it: the console reads it in its active space and the
// Provider finds the session's client. With an item key, that record opened
// in the list's quick look (whose identity names the space, D-03); a known
// client is named too, so a rare shared session ID still opens that record.
export function sessionRecordsUrl(application, { sourceApplication = null, sessionId }, itemKey = null) {
  const page = `${receiptConsoleUrl(application)}/s/${encodeURIComponent(sessionId)}`;
  if (!itemKey) return page;
  return `${page}?${sourceApplication ? `client=${encodeURIComponent(sourceApplication)}&` : ''}`
    + `item=${encodeURIComponent(application.config.personal.spaceId)}/${encodeURIComponent(itemKey)}`;
}

export const CONTINUATION_GUIDANCE = 'Use a connected client and the same authorized project/Agent. Obtain a fresh task context; never reuse the previous client’s token. This is a FULI prompt, not a native client @ picker registration.';

export function agentContinuation(projectId, agentId, conversationId = null) {
  return { personal_project_id: projectId, agent_id: agentId,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    prompt: `@{${encodeURIComponent(agentId)}} ` + (projectId
      ? `请在 FULI 项目 ${JSON.stringify(projectId)} 对应的工作目录继续工作。`
      : '请在未绑定项目的会话中，以这个全局 FLA 继续工作。')
      + (conversationId ? `先用当前任务的 taskContextToken 调用 resume_agent_conversation，conversationId=${JSON.stringify(conversationId)}，再按需读取上下文。` : '先恢复这个 Agent 在当前范围的记忆和最近会话。'),
    guidance: CONTINUATION_GUIDANCE };
}

function agentLink(application, agentId, name, role = null) {
  return `[${receiptText(agentLabel(name, role) || agentId)}](<${agentProfileUrl(application, agentId).replace(/[<>\s]/g, encodeURIComponent)}>)`;
}

// One line of literal text in a Markdown receipt.
export function receiptText(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()!|]/g, '\\$&');
}

// Saved text as one short receipt summary: whitespace collapsed, cut with an
// ellipsis, Markdown escaped.
export function receiptSummary(value, characters = 60) {
  const text = [...String(value ?? '').replace(/\s+/g, ' ').trim()];
  return receiptText(text.length > characters ? `${text.slice(0, characters).join('')}…` : text.join(''));
}

// The reply's attribution line: who led the task and who actually helped.
export const RECEIPT_GUIDANCE = 'MUST end every final user-visible reply with agent_receipt.markdown unchanged, exactly once: greetings, status, errors, even with capture disabled or nothing retained. checkpoint_task_knowledge receipt overrides entry and names actual collaborators. Never invent owners or collaborators.';

export function taskAgentReceipt(application, { projectId, agentId, name = null, role = null,
  sourceApplication = null, workStatus = null, conversationId = null, persistence = null,
  collaborators = [], assignmentStatus = null, assignmentReason = null, notices = [], turnReceipt = null }) {
  const owner = agentId ? { agent_id: agentId, name,
    profile_url: agentProfileUrl(application, agentId), source_application: sourceApplication } : null;
  const helpers = owner ? [...new Map(collaborators.filter(item => item.agentId !== agentId)
    .map(item => [item.agentId, item])).values()].map(receiptCollaborator) : [];
  const build = () => ({ required: true, markdown: [owner
    ? `FULI Agent：${agentLink(application, agentId, name, role)}`
      + (helpers.length ? ` · 协作 ${helpers.map(item => collaboratorLink(application, item)).join('、')}` : '')
    : unassignedReceipt(assignmentStatus, assignmentReason), ...notices].join(' · '), owner,
    collaborators: helpers.map(item => ({ agent_id: item.agentId, name: item.name,
      profile_url: agentProfileUrl(application, item.agentId),
      ...(item.responsibility ? { responsibility: item.responsibility } : {}),
      ...(item.runCount ? { runs: item.runs, run_count: item.runCount,
        omitted_run_count: item.runCount - item.runs.length } : {}) })),
    personal_project_id: projectId, work_status: workStatus, persistence,
    continuation: owner ? agentContinuation(projectId, agentId, conversationId) : null,
    guidance: RECEIPT_GUIDANCE });
  let receipt = build();
  // Reserve room within checkpoint's 16 KiB response. Only optional execution
  // detail is removed: every proven helper and the exact total remain visible.
  while (Buffer.byteLength(JSON.stringify(receipt)) > 12 * 1024) {
    const largest = [...helpers].filter(item => item.runs.length)
      .sort((a, b) => Buffer.byteLength(JSON.stringify(b.runs)) - Buffer.byteLength(JSON.stringify(a.runs)))[0];
    if (largest) largest.runs.pop();
    else {
      const detail = helpers.find(item => item.responsibility);
      if (!detail) break; // Preserve the existing identity-only receipt contract.
      detail.responsibility = null;
    }
    receipt = build();
  }
  return withTurnReceipt(receipt, turnReceipt);
}

// What a turn saved follows the identity line (rec#20); nothing when nothing changed.
export function withTurnReceipt(receipt, turnReceipt) {
  if (!turnReceipt) return receipt;
  const lines = withReceiptLines(receipt, turnReceipt.lines);
  return turnReceipt.summary ? { ...lines, turn_receipt: turnReceipt.summary } : lines;
}

// Lines appended to the receipt the Agent copies unchanged.
export function withReceiptLines(receipt, lines) {
  return lines?.length ? { ...receipt, markdown: [receipt.markdown, ...lines].join('\n') } : receipt;
}

function collaboratorLink(application, item) {
  const duties = [...new Set((item.runs ?? []).map(run => run.worker_label || run.work_kind).filter(Boolean))];
  const sessions = new Map();
  for (const run of item.runs ?? []) {
    const url = receiptSessionUrl(run.session_url);
    const status = { completed: '完成', failed: '失败', cancelled: '取消', blocked: '阻塞', awaiting_review: '待验收' }[run.status];
    if (url) sessions.set(`${run.application}:${run.session_id}`, `[会话${status ? `·${status}` : ''}](<${url}>)`);
  }
  const omitted = item.runCount - (item.runs?.length ?? 0);
  const detail = [...duties.map(receiptText), ...sessions.values(), ...(omitted > 0 ? [`另${omitted}次`] : [])].join('，');
  return agentLink(application, item.agentId, item.name) + (detail ? `（${detail}）` : '');
}

// The full evidence stays in the immutable checkpoint. Mandatory receipts must
// fit the transport's per-array limit even after many retries of one worker.
function receiptCollaborator(item) {
  const text = (value, max) => typeof value === 'string' ? [...value].slice(0, max).join('') : null;
  const runs = (item.runs ?? []).slice(0, 3).map(run => ({
    run_id: text(run.run_id, 128), task_id: text(run.task_id, 128),
    work_kind: text(run.work_kind, 64), worker_label: text(run.worker_label, 80),
    application: text(run.application, 32), session_id: text(run.session_id, 256),
    session_url: typeof run.session_url === 'string' && run.session_url.length <= 512 ? receiptSessionUrl(run.session_url) : null,
    status: text(run.status, 32)
  }));
  return { ...item, responsibility: text(item.responsibility, 160), runs, runCount: item.runs?.length ?? 0 };
}

function receiptSessionUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        && !(url.protocol === 'codex:' && url.hostname === 'threads' && url.pathname !== '/')) return null;
    return url.href.replace(/[<>\s]/g, encodeURIComponent);
  } catch { return null; }
}

function unassignedReceipt(status, reason) {
  if (!status) return 'FULI Agent：分配未完成（任务没有可用负责人）';
  if (status === 'project_unresolved') {
    return reason === 'ambiguous' ? 'FULI Agent：分配待确认（项目归属待确认）'
      : reason === 'session_identity_required' ? 'FULI Agent：分配失败（缺少会话标识）'
        : 'FULI Agent：分配失败（项目归属未能恢复）';
  }
  if (reason === 'assistant_unavailable') return 'FULI Agent：待归属会话（助理尚未就绪）';
  if (status === 'agent_unavailable' && reason === 'not_responsible') return 'FULI Agent：分配失败（指定 Agent 未负责此项目）';
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
