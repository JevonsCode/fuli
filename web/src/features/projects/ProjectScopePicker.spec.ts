import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { PersonalProject } from '@/types'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { projectScopeKey } from './project-scope-choices'

// Synthetic projects only: 2 named, 130 temporary with distinct digests and days.
const named = (id: string, name: string): PersonalProject => ({ project_id: id, personal_space_id: 'space', profile: { name } })
const temporary = (index: number): PersonalProject => ({
  project_id: `temporary-${index.toString(16).padStart(4, '0').repeat(16)}`, personal_space_id: 'space',
  scope_type: 'temporary', profile: { name: '' },
  updated_at: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
})
const projects = [named('alpha', 'Synthetic alpha'), named('beta', 'Synthetic beta'),
  ...Array.from({ length: 130 }, (_, index) => temporary(index + 1))]

function mountPicker(selected: string[] = []) {
  const toggles: [string[], boolean][] = []
  const wrapper = mount(ProjectScopePicker, {
    props: { projects, selected, idPrefix: 'spec', onToggle: (keys: string[], on: boolean) => { toggles.push([keys, on]) } },
  })
  return { wrapper, toggles }
}

describe('ProjectScopePicker with hundreds of temporary projects', () => {
  it('lists named projects, folds the temporary ones into one row with how many are chosen', () => {
    const { wrapper } = mountPicker([projectScopeKey(projects[2]!)])
    expect(wrapper.findAll('[data-project-scope-formal]').map(row => row.text())).toEqual(['Synthetic alpha', 'Synthetic beta'])
    expect(wrapper.get('[data-project-scope-temporary-count]').text()).toBe('1/130')
    expect(wrapper.find('[data-project-scope-temporary-item]').exists()).toBe(false)
  })

  it('opens a page of 50 at a time, newest first', async () => {
    const { wrapper } = mountPicker()
    await wrapper.get('[data-project-scope-temporary-toggle]').trigger('click')
    expect(wrapper.findAll('[data-project-scope-temporary-item]')).toHaveLength(50)
    expect(wrapper.get('[data-project-scope-more]').text()).toBe('再显示 50 个（还有 80 个）')
    await wrapper.get('[data-project-scope-more]').trigger('click')
    await wrapper.get('[data-project-scope-more]').trigger('click')
    expect(wrapper.findAll('[data-project-scope-temporary-item]')).toHaveLength(130)
    expect(wrapper.find('[data-project-scope-more]').exists()).toBe(false)
  })

  it('finds one project by its number among all of them, past the first page', async () => {
    const { wrapper } = mountPicker()
    const last = projects.at(-1)!
    await wrapper.get('[data-project-scope-search] input, input[data-project-scope-search]').setValue('00820082')
    await flushPromises()
    const items = wrapper.findAll('[data-project-scope-temporary-item]')
    expect(items).toHaveLength(1)
    expect(items[0]!.get('label').attributes('title')).toBe(last.project_id)
  })

  it('全选 takes the formal projects only and says a later project is not in it; the folded row takes the temporary ones; 清空 lets every one go', async () => {
    const { wrapper, toggles } = mountPicker()
    expect(wrapper.get('[data-project-scope-note]').text()).toBe('之后新建的项目不会自动加入')
    await wrapper.get('[data-project-scope-all]').trigger('click')
    expect(toggles.at(-1)).toEqual([[projectScopeKey(projects[0]!), projectScopeKey(projects[1]!)], true])
    // The temporary row's own box takes all 130 of them.
    await wrapper.get('[data-project-scope-temporary] button[role="checkbox"]').trigger('click')
    expect(toggles.at(-1)![1]).toBe(true)
    expect(toggles.at(-1)![0]).toHaveLength(130)
    // With the formal ones chosen, 全选 has nothing left to take, whatever temporary ones wait.
    expect(mountPicker([projectScopeKey(projects[0]!), projectScopeKey(projects[1]!)]).wrapper
      .get('[data-project-scope-all]').attributes('disabled')).toBeDefined()
    const all = mountPicker(projects.map(projectScopeKey))
    await all.wrapper.get('[data-project-scope-clear]').trigger('click')
    expect(all.toggles.at(-1)![1]).toBe(false)
    expect([...all.toggles.at(-1)![0]].sort()).toEqual(projects.map(projectScopeKey).sort())
  })
})
