import { describe, expect, it } from 'vitest'

import page from '../../pages/AgentProfilePage.vue?raw'
import board from '../employees/EmployeeTaskBoard.vue?raw'

// Workbench-style FLA page (Jevons 11-02): on a wide window the identity stays
// on the left, only the right column scrolls, and the page itself never does.
describe('FLA page layout', () => {
  it('puts the identity card in the side column and everything else in the main column', () => {
    const side = page.slice(page.indexOf('<aside class="agent-profile-side">'), page.indexOf('</aside>'))
    expect(side).toContain('class="agent-resume-header"')
    expect(side).toContain('<AgentRenameHint')
    const main = page.slice(page.indexOf('<div class="agent-profile-main">'))
    expect(main).toContain('class="agent-profile-tabs')
  })

  it('fixes the page and scrolls the right column from 1100px', () => {
    const wide = page.slice(page.indexOf('@media (min-width: 1100px)'))
    expect(wide).toMatch(/\.agent-profile-page \{[^}]*overflow: hidden;/)
    expect(wide).toMatch(/\.agent-profile-layout \{[^}]*grid-template-columns: 320px minmax\(0, 1fr\);/)
    expect(wide).toMatch(/\.agent-profile-main \{[^}]*overflow-y: auto;[^}]*padding-bottom: var\(--dock-clearance\);/)
  })

  it('lets the five board columns fit beside the side column', () => {
    expect(board).toMatch(/\.employee-all-projects-board \{[^}]*minmax\(150px, 1fr\)/)
  })
})
