import { currentLocale } from '@/i18n'

export function copy(zh: string, en: string) { return currentLocale() === 'zh-CN' ? zh : en }
const labels: Record<string, [string, string]> = {
  draft: ['草案', 'Draft'], active: ['进行中', 'Active'], paused: ['已暂停', 'Paused'],
  waiting_input: ['等待你的判断', 'Awaiting your decision'], waiting_auth: ['等待授权', 'Awaiting authorization'],
  concluded: ['已结束', 'Concluded'], failed: ['失败', 'Failed'], cancelled: ['已停止', 'Stopped'],
  discussion: ['讨论', 'Discussion'], collaboration: ['协作任务', 'Collaborative task'], planning: ['分工', 'Planning'],
  implementation: ['实施', 'Implementation'], review: ['审查', 'Review'], synthesis: ['汇总', 'Synthesis'],
  moderator: ['主持人', 'Moderator'], specialist: ['专家', 'Specialist'], implementer: ['实施者', 'Implementer'], reviewer: ['审查者', 'Reviewer'],
  pending: ['待处理', 'Pending'], claimed: ['已领取', 'Claimed'], running: ['运行中', 'Running'],
  reported_complete: ['已报告完成', 'Completion reported'], completed: ['已提交回合', 'Turn submitted'], interrupted: ['已中断', 'Interrupted'],
  blocked: ['受阻', 'Blocked'], expired: ['已过期', 'Expired'], cancellation_requested: ['已请求取消', 'Cancellation requested'],
  human_accepted: ['已由人确认', 'Accepted by human'], task_verified: ['任务验证通过', 'Task verified'],
  'read-only': ['只读', 'Read only'], 'workspace-write': ['允许写入工作区', 'Workspace write'],
  mcp: ['MCP · 主动参与', 'MCP · active participation'], codex: ['Codex CLI', 'Codex CLI'],
  'claude-code': ['Claude Code CLI', 'Claude Code CLI'], pi: ['Pi · 本地 Ollama', 'Pi · local Ollama'], grok: ['Grok · xAI API', 'Grok · xAI API'], a2a: ['A2A · 协议适配', 'A2A · protocol adapter'],
  proposal: ['提案', 'Proposal'], question: ['提问', 'Question'], handoff: ['交接', 'Handoff'], result: ['结果', 'Result'],
  dissent: ['分歧', 'Dissent'], user: ['你的补充', 'Your input'], human: ['你的补充', 'Your input'], system: ['系统事件', 'System event'],
  seat_joined: ['席位加入', 'Seat joined'], turn_claimed: ['回合被领取', 'Turn claimed'], phase_changed: ['阶段改变', 'Phase changed'],
  attempt_failed: ['尝试失败', 'Attempt failed'], attempt_interrupted: ['尝试中断', 'Attempt interrupted'], owner_control: ['所有者操作', 'Owner control'],
  invitation_issued: ['邀请已签发', 'Invitation issued'], invitation_revoked: ['邀请已撤销', 'Invitation revoked'], owner_completed: ['所有者验收', 'Owner acceptance'],
  turn_skipped: ['回合被跳过', 'Turn skipped'],
}
export function label(value?: string | null) {
  if (!value) return copy('未知', 'Unknown')
  const item = labels[value]
  return item ? copy(...item) : value
}
export function time(value?: string | number | null) {
  if (!value) return copy('未知', 'Unknown')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(currentLocale(), { hour12: false })
}
export function artifactText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return copy('未提供标识', 'No identifier reported')
  const artifact = value as Record<string, unknown>
  return [artifact.title ?? artifact.name, artifact.uri ?? artifact.path ?? artifact.id].filter(v => typeof v === 'string').join(' · ') || copy('未提供标识', 'No identifier reported')
}
