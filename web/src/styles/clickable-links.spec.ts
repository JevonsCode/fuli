import { describe, expect, it } from 'vitest'
import flaRow from '@/features/flas/FlaRow.vue?raw'
import teamCard from '@/features/team-work/TeamCard.vue?raw'
import modelSettings from '@/pages/ModelSettingsPage.vue?raw'
import agentProfile from '@/features/agent-profile/agent-profile.css?raw'

// A link that reads as a control (a whole FLA row, 打开任务, a card's name or
// current task, 查看详情) is clicked, not read: a drag across it never
// highlights its label (Jevons 11-01). Plain inline links in prose stay selectable.
const rule = (source: string, selector: string) => {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return source.slice(start, source.indexOf('}', start))
}

describe('links drawn as controls', () => {
  it.each([
    ['FLA row', flaRow, '.fla-row'],
    ['打开任务', teamCard, '.team-open'],
    ['team member name', teamCard, '.team-share-name'],
    ['agent card name', agentProfile, '.agent-card-name'],
    ['agent card current task', agentProfile, '.agent-card-current-task'],
    ['model guide 查看详情', modelSettings, '.model-guide-link'],
  ])('keeps the %s label out of text selection', (_name, source, selector) => {
    expect(rule(source, selector)).toContain('user-select: none')
  })
})
