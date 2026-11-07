import { describe, expect, it } from 'vitest'
import cards from '@/features/agent-profile/agent-profile.css?raw'
import rows from '@/features/review-list/review-rows.css?raw'
import projectAgentCard from '@/features/project-agents/ProjectAgentCard.vue?raw'

const rule = (source: string, selector: string) => {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return source.slice(start, source.indexOf('}', start))
}

describe('row centre lines', () => {
  it('wraps Tonborg\'s group heading on a narrow screen instead of cutting it to 「Tonborg 拿不…」', () => {
    expect(rule(rows, '.review-group__title--asks')).toContain('white-space: normal')
    expect(rule(rows, '.review-group__name')).not.toContain('text-overflow: ellipsis')
  })

  it('centres the raised hand on the first line of an agent card name', () => {
    expect(cards).toContain('.agent-card-hand { margin-block: calc((16px * 1.35 - 28px) / 2); }')
    expect(rule(cards, '.agent-card-name')).toContain('font-size: 16px')
    expect(rule(cards, '.agent-card-name')).toContain('line-height: 1.35')
    expect(projectAgentCard).toContain('<AgentHand class="agent-card-hand"')
  })
})
