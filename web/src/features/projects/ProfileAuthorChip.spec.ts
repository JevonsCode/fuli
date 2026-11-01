import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { findTerm } from '@/features/glossary/terms'
import ProfileAuthorChip from './ProfileAuthorChip.vue'
import source from './ProfileAuthorChip.vue?raw'

// Synthetic Agent ids and names only.
describe('ProfileAuthorChip', () => {
  it('names the FLA with its portrait for an Agent draft, its weight in the tooltip', () => {
    const chip = mount(ProfileAuthorChip, { props: { author: { kind: 'agent', agent_id: 'agent-ada', agent_name: 'Ada' } } })
    expect(chip.text()).toBe('Ada 写的')
    expect(chip.get('img').attributes('src')).toBe(agentAvatarUrl('agent-ada'))
    expect(chip.get('[data-author]').attributes('title')).toContain('50%')
    expect(chip.get('[data-author]').attributes('data-term')).toBe('authorship.agent')
  })

  it('shows the person alone, and both portraits for shared text', () => {
    const person = mount(ProfileAuthorChip, { props: { author: { kind: 'person' } } })
    expect(person.text()).toContain('我写的')
    expect(person.find('img').exists()).toBe(false)
    expect(person.get('[data-author]').attributes('title')).toContain('100%')
    const both = mount(ProfileAuthorChip, { props: { author: { kind: 'both', agent_id: 'agent-ada', agent_name: 'Ada' } } })
    expect(both.get('.profile-author-label').text()).toBe('我和 Ada')
    expect(both.findAll('.ui-avatar')).toHaveLength(2)
    expect(both.get('[data-author]').attributes('title')).toContain('90%')
  })

  it('says AI for FULI\'s own draft and shows nothing for a field without a record', () => {
    const unnamed = mount(ProfileAuthorChip, { props: { author: { kind: 'agent' } } })
    expect(unnamed.text()).toBe('AI 写的')
    expect(unnamed.find('.ui-avatar').exists()).toBe(false)
    expect(mount(ProfileAuthorChip, { props: { author: null } }).html()).toBe('<!--v-if-->')
  })

  it('is not text to select and explains its kind in the glossary', () => {
    expect(source).toMatch(/user-select: none/)
    const chip = mount(ProfileAuthorChip, { props: { author: { kind: 'both', agent_name: 'Ada' } }, attachTo: document.body })
    expect(findTerm(chip.get('.profile-author-label').element)?.term.id).toBe('authorship.both')
    chip.unmount()
  })
})
