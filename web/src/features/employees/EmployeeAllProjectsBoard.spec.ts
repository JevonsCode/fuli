import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import EmployeeAllProjectsBoard, { type EmployeeBoardItem } from './EmployeeAllProjectsBoard.vue'

const task: EmployeeBoardItem = {
  id: 'task-1',
  projectId: 'project-a',
  title: '整理发布清单',
  status: 'planned',
  updatedAt: '2026-09-03T00:00:00.000Z',
}

function setup(canMoveTasks = true) {
  return mount(EmployeeAllProjectsBoard, {
    attachTo: document.body,
    props: {
      boards: [{ project: { id: 'project-a', name: '发布项目' }, items: [task], total: 1, truncated: false }],
      projects: [{ id: 'project-a', name: '发布项目' }],
      visibleProjectIds: ['project-a'],
      failedProjects: 0,
      canMoveTasks,
    },
  })
}

describe('all-project employee board', () => {
  it('moves a card between status columns with the keyboard drag controls', async () => {
    const wrapper = setup()
    const handle = wrapper.get('.employee-all-projects-drag-handle')

    await handle.trigger('keydown', { key: ' ' })
    expect(document.body.textContent).toContain('整理发布清单')
    await handle.trigger('keydown', { key: 'ArrowRight' })
    await handle.trigger('keydown', { key: ' ' })

    expect(wrapper.emitted('move-task')).toEqual([[task, 'active']])
    wrapper.unmount()
  })

  it('keeps project filtering separate from assignment scope', async () => {
    const wrapper = setup()
    await wrapper.get('.project-scope-trigger').trigger('click')
    await wrapper.get('input[value="project-a"]').setValue(false)
    expect(wrapper.emitted('update:visible-project-ids')).toEqual([[[]]])
    wrapper.unmount()
  })

  it('keeps tasks readable when the Agent has no write permission', () => {
    const wrapper = setup(false)
    expect(wrapper.get('.employee-all-projects-task-open').text()).toContain('整理发布清单')
    expect(wrapper.find('.employee-all-projects-drag-handle').exists()).toBe(false)
    wrapper.unmount()
  })
})
