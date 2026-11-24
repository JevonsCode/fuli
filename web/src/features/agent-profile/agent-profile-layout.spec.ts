import { describe, expect, it } from 'vitest'

import page from '../../pages/AgentProfilePage.vue?raw'
import board from '../employees/EmployeeTaskBoard.vue?raw'

// One FLA page (Jevons 11-04, docs/fla-page.md): who it is and what it is
// doing now stay at the top, only its work below scrolls, and on a wide window
// the page itself never does.
describe('FLA page layout', () => {
  it('keeps identity and 现在 in the fixed region, with the one action beside the name', () => {
    const side = page.slice(page.indexOf('<PageStack class="agent-profile-side">'), page.indexOf('<div ref="workColumn" class="agent-profile-main">'))
    expect(side).toContain('class="fla-head"')
    expect(side).toContain('<FlaHandOff')
    expect(side).toContain('<FlaNow')
    expect(side).toContain('<AgentRenameHint')
    // The responsibility is read once, further down, never clamped in the header.
    expect(side).not.toContain('agentResponsibility')
    const main = page.slice(page.indexOf('<div ref="workColumn" class="agent-profile-main">'))
    expect(main).toContain('class="agent-profile-tabs')
  })

  it('reads the column in the order people ask: work, what it finished, where, what it is for, then configuration', () => {
    const order = ['place="fla.overview"', '<FlaRecentWork', 'place="fla.history"', '<FlaResponsibility', 'place="fla.profile"']
    const at = order.map(marker => page.indexOf(marker))
    expect(at.every(index => index > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('fixes the page and scrolls the work from 1100px', () => {
    const wide = page.slice(page.indexOf('@media (min-width: 1100px)'))
    expect(wide).toMatch(/\.agent-profile-page \{[^}]*overflow: hidden;/)
    expect(wide).not.toContain('grid-template-columns')
    expect(wide).toMatch(/\.agent-profile-main \{[^}]*overflow-y: auto;[^}]*padding-bottom: var\(--dock-clearance\);/)
  })

  it('lets the five board columns narrow before they scroll', () => {
    expect(board).toMatch(/\.employee-all-projects-board \{[^}]*minmax\(150px, 1fr\)/)
  })
})
