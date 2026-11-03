import type { AgentOccupationKey, ProjectAgentRecord } from '@/types'

/**
 * Older FLAs were created before occupations existed and still show
 * 「还没有设置职业」 (11-03). Their occupation is read from what they are for:
 * the first built-in occupation whose words their responsibility and
 * capabilities use. The project leads FULI created early on carry its lead
 * wording (「负责 X 的开发、修复、测试与交付」, 「统筹 … 交付」), so they become
 * 负责人 before any single skill word matches. An FLA whose words match
 * nothing gets no guess: the person sets it on its page.
 */
const LEAD = /统筹|负责人|分工|开发、修复、测试与交付|team lead|coordinat/i

const RULES: ReadonlyArray<readonly [AgentOccupationKey, RegExp]> = [
  ['qa_automation', /自动化测试|test automation|\bQA\b/i],
  ['testing', /测试|验收|\btest(ing|er)?\b/i],
  ['frontend', /前端|界面|\bUI\b|frontend/i],
  ['backend', /后端|服务端|接口|backend|\bAPI\b/i],
  ['mobile', /移动端|\biOS\b|Android|mobile/i],
  ['devops', /运维|部署|构建|\bCI\b|devops|deploy/i],
  ['security', /安全|security/i],
  ['architecture', /架构|architect/i],
  ['design', /设计|design/i],
  ['documentation', /文档|documentation|\bdocs?\b/i],
  ['translation', /翻译|translat/i],
  ['research', /研究|调研|research/i],
  ['data', /数据|指标|analytics|\bdata\b/i],
  ['writing', /写作|文案|writing|copy/i],
  ['product', /产品|需求|product/i],
  ['marketing', /市场|营销|marketing/i],
  ['support', /客服|用户支持|support/i],
  ['operations', /运营|operations/i],
  ['engineering', /开发|工程|编码|代码|实现|engineer|develop|\bcode\b/i],
]

export function suggestedOccupation(agent: ProjectAgentRecord): AgentOccupationKey | null {
  const text = [agent.profile.responsibility, ...agent.profile.capabilities].filter(Boolean).join(' ')
  if (!text.trim()) return null
  if (LEAD.test(text)) return 'lead'
  return RULES.find(([, words]) => words.test(text))?.[0] ?? null
}

/** Active FLAs of the person's own (not FULI's built-in roles) that have no occupation yet. */
export function lacksOccupation(agent: ProjectAgentRecord) {
  return agent.profile.status === 'active' && !agent.agentId.startsWith('employee.') && !agent.occupation?.role
}
