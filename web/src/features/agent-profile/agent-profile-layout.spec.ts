import { describe, expect, it } from 'vitest'

import page from '../../pages/AgentProfilePage.vue?raw'
import board from '../employees/EmployeeTaskBoard.vue?raw'

// One FLA page (Jevons 11-04): who it is runs across the top, only its work
// below scrolls, and on a wide window the page itself never does.
describe('FLA page layout', () => {
  it('puts the identity card above the tabs, across the page', () => {
    const side = page.slice(page.indexOf('<div class="agent-profile-side"'), page.indexOf('<div class="agent-profile-main"'))
    expect(side).toContain('class="agent-resume-header"')
    expect(side).toContain('<AgentRenameHint')
    const main = page.slice(page.indexOf('<div class="agent-profile-main"'))
    expect(main).toContain('class="agent-profile-tabs')
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
