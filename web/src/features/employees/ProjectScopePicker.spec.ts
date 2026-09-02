import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import ProjectScopePicker from './ProjectScopePicker.vue'

const projects = [{ id: 'alpha', name: 'Alpha 项目' }, { id: 'beta', name: 'Beta 项目' }, { id: 'gamma', name: 'Gamma 项目' }]
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => setLocale('zh-CN', { persist: false }))
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

function setup(modelValue: string[] = []) {
  const wrapper = mount(ProjectScopePicker, {
    attachTo: document.body,
    props: { projects, modelValue, 'onUpdate:modelValue': (value: string[]) => { void wrapper.setProps({ modelValue: value }) } },
  })
  mounted.push(wrapper)
  return wrapper
}

describe('employee project multi-select', () => {
  it('supports all, individual exclusion, inversion, and clearing with mixed checkbox state', async () => {
    const wrapper = setup()
    await wrapper.get('.project-scope-trigger').trigger('click')
    await wrapper.get('.project-scope-all input').setValue(true)
    expect(wrapper.props('modelValue')).toEqual(['alpha', 'beta', 'gamma'])
    await wrapper.get('input[value="beta"]').setValue(false)
    expect(wrapper.props('modelValue')).toEqual(['alpha', 'gamma'])
    expect((wrapper.get('.project-scope-all input').element as HTMLInputElement).indeterminate).toBe(true)
    await wrapper.get('.project-scope-bulk button').trigger('click')
    expect(wrapper.props('modelValue')).toEqual(['beta'])
    await wrapper.get('.project-scope-all input').setValue(true)
    await wrapper.get('.project-scope-all input').setValue(false)
    expect(wrapper.props('modelValue')).toEqual([])
  })

  it('keeps selections across search and applies clearly labelled bulk actions to every project', async () => {
    const wrapper = setup(['beta'])
    await wrapper.get('.project-scope-trigger').trigger('click')
    await wrapper.get('input[type="search"]').setValue('Alpha')
    expect(wrapper.find('input[value="beta"]').exists()).toBe(false)
    await wrapper.get('input[value="alpha"]').setValue(true)
    expect(wrapper.props('modelValue')).toEqual(['alpha', 'beta'])
    await wrapper.get('.project-scope-all input').setValue(true)
    expect(wrapper.props('modelValue')).toHaveLength(3)
    await wrapper.get('input[type="search"]').setValue('No match')
    expect(wrapper.text()).toContain('没有匹配')
    expect(wrapper.text()).toContain('已选 3 / 3')
  })

  it('closes with Escape without closing the parent dialog and restores keyboard focus', async () => {
    const wrapper = setup()
    await wrapper.get('.project-scope-trigger').trigger('click')
    expect(document.activeElement).toBe(wrapper.get('input[type="search"]').element)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    wrapper.get('input[type="search"]').element.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.find('.project-scope-panel').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('.project-scope-trigger').element)
  })

  it('blocks selection changes while disabled and supports empty and long-name projects', async () => {
    const wrapper = setup()
    await wrapper.get('.project-scope-trigger').trigger('click')
    await wrapper.setProps({ disabled: true })
    expect(wrapper.find('.project-scope-panel').exists()).toBe(false)
    expect(wrapper.get('.project-scope-trigger').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ disabled: false, projects: [] })
    await wrapper.get('.project-scope-trigger').trigger('click')
    expect(wrapper.text()).toContain('暂无可选项目')
    expect(wrapper.get('.project-scope-all input').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ projects: [{ id: 'long', name: '很长的项目名称'.repeat(12) }] })
    expect(wrapper.find('input[value="long"]').exists()).toBe(true)
  })

  it('shows checkboxes immediately in the inline management view and keeps later projects unselected', async () => {
    const wrapper = setup(['alpha', 'beta', 'gamma'])
    await wrapper.setProps({ inline: true })
    expect(wrapper.find('.project-scope-trigger').exists()).toBe(false)
    expect(wrapper.findAll('.project-scope-list input[type="checkbox"]')).toHaveLength(3)
    await wrapper.setProps({ projects: [...projects, { id: 'later', name: '后来创建的项目' }] })
    expect((wrapper.get('input[value="later"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.get('.project-scope-count').text()).toContain('3 / 4')
    await wrapper.setProps({ disabled: true })
    expect(wrapper.get('input[value="alpha"]').attributes('disabled')).toBeDefined()
  })

  it('labels the compact filter separately from assignment management', async () => {
    const wrapper = setup(['alpha'])
    await wrapper.setProps({ compact: true, label: '筛选项目', hint: '仅筛选列表', emptyLabel: '未选择项目' })
    expect(wrapper.get('.project-scope-trigger').text()).toContain('Alpha 项目')
    expect(wrapper.get('.project-scope-trigger').text()).toContain('多选')
    await wrapper.get('.project-scope-trigger').trigger('click')
    expect(wrapper.text()).toContain('仅筛选列表')
    await wrapper.get('input[value="alpha"]').setValue(false)
    expect(wrapper.get('.project-scope-trigger').text()).toContain('未选择项目')
  })

  it('distinguishes projects with the same display name using their project identifier', async () => {
    const wrapper = setup(['alpha'])
    await wrapper.setProps({ projects: [{ id: 'alpha', name: '同名项目' }, { id: 'beta', name: '同名项目' }] })
    expect(wrapper.get('.project-scope-trigger').text()).toContain('同名项目 · alpha')
    await wrapper.get('.project-scope-trigger').trigger('click')
    expect(wrapper.findAll('.project-scope-project-id').map((item) => item.text())).toEqual(['alpha', 'beta'])
    await wrapper.get('input[value="beta"]').setValue(true)
    expect(wrapper.get('.project-scope-trigger').text()).toContain('全部项目')
  })
})
