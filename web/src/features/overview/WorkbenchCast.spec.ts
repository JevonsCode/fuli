import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { ProjectAgentTaskParticipant } from '@/types'
import WorkbenchCast from './WorkbenchCast.vue'

// Synthetic FLAs only.
const fla = (agentId: string, status: string, assignmentSummary: string | null = null) => ({ agentId, role: 'collaborator', status, assignmentSummary }) as ProjectAgentTaskParticipant
const RouterLink = { props: ['to'], template: '<a :href="to"><slot /></a>' }

beforeEach(() => setLocale('zh-CN', { persist: false }))

function cast(props: Partial<InstanceType<typeof WorkbenchCast>['$props']> = {}) {
  return mount(WorkbenchCast, {
    props: {
      flas: [fla('done-one', 'completed', 'Synthetic part'), fla('live-one', 'running')],
      counts: new Map([['live-one', 3]]),
      agentName: (id?: string | null) => `FLA ${id}`,
      statusLabel: (status: string) => `status ${status}`,
      project: { name: 'Synthetic project', to: '/personal/s/projects/p/directory' },
      ...props,
    },
    global: { stubs: { RouterLink } },
  })
}

describe('who is on the work, beside the timeline', () => {
  it('puts the FLAs at work first, marks a finished part, and counts each one\'s steps', () => {
    const wrapper = cast()
    const rows = wrapper.findAll('[data-cast-fla]')
    expect(rows.map(row => row.attributes('data-cast-fla'))).toEqual(['live-one', 'done-one'])
    expect(rows[0]!.classes()).toContain('is-live')
    expect(rows[0]!.text()).toContain('3 条')
    expect(rows[1]!.classes()).toContain('is-done')
    expect(rows[1]!.text()).toContain('Synthetic part')
  })

  it('shows only the chosen FLA\'s steps, and everyone\'s when it is chosen again', async () => {
    const wrapper = cast()
    await wrapper.get('[data-cast-fla="live-one"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['live-one'])
    await wrapper.setProps({ modelValue: 'live-one' })
    expect(wrapper.get('[data-cast-fla="live-one"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-cast-fla="done-one"]').classes()).toContain('is-dim')
    await wrapper.get('[data-cast-fla="live-one"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([null])
  })

  it('links a registered project and names a temporary one without a link', () => {
    expect(cast().get('[data-cast-project]').attributes('href')).toBe('/personal/s/projects/p/directory')
    const temporary = cast({ project: { name: 'Scratch', to: null } })
    expect(temporary.get('[data-cast-project]').element.tagName).toBe('SPAN')
  })
})
