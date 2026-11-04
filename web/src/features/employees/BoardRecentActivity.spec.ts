import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import BoardRecentActivity from './BoardRecentActivity.vue'
import type { EmployeeBoardItem } from './task-board-model'

const item = (id: string, updatedAt?: string): EmployeeBoardItem => ({ id, projectId: 'project-a', title: `Task ${id}`, status: 'active', updatedAt })
const boards = (items: EmployeeBoardItem[]) => [{ project: { id: 'project-a', name: 'Synthetic project' }, items, total: items.length, truncated: false }]

describe('BoardRecentActivity', () => {
  it('lists the latest updates first, five at a time, and leaves out a task with no time', async () => {
    const days = ['01', '02', '03', '04', '05', '06']
    const wrapper = mount(BoardRecentActivity, { props: { boards: boards([...days.map(day => item(day, `2026-11-${day}T00:00:00Z`)), item('undated')]) } })
    const rows = () => wrapper.findAll('[data-board-activity-row]')
    expect(rows()).toHaveLength(5)
    expect(rows()[0]!.text()).toContain('Task 06')
    await wrapper.get('[data-board-activity-all]').trigger('click')
    expect(rows()).toHaveLength(6)
    expect(wrapper.text()).not.toContain('Task undated')
  })

  it('opens the task a row names', async () => {
    const task = item('one', '2026-11-01T00:00:00Z')
    const wrapper = mount(BoardRecentActivity, { props: { boards: boards([task]) } })
    await wrapper.get('[data-board-activity-row]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([[task]])
  })

  it('shows nothing when no task has an update', () => {
    expect(mount(BoardRecentActivity, { props: { boards: boards([]) } }).find('[data-board-activity]').exists()).toBe(false)
  })
})
