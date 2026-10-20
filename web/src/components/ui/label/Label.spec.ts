import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { Input } from '../input'
import { Label } from '.'

describe('Label', () => {
  it('renders a native label that names the control it points at', () => {
    const wrapper = mount({
      render: () => [h(Label, { for: 'project-name' }, () => '项目名称'), h(Input, { id: 'project-name' })],
    }, { attachTo: document.body })
    const label = wrapper.get('label')
    expect(label.attributes('data-slot')).toBe('label')
    expect(label.attributes('for')).toBe('project-name')
    expect(label.text()).toBe('项目名称')
    const input = document.getElementById('project-name') as HTMLInputElement
    expect([...(input.labels ?? [])].map(item => item.textContent)).toEqual(['项目名称'])
    wrapper.unmount()
  })

  it('lets a caller class win', () => {
    const label = mount(Label, { props: { class: 'text-xs' } }).get('label')
    expect(label.classes()).toContain('text-xs')
    expect(label.classes()).not.toContain('text-sm')
  })
})
