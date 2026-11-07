import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '.'

// Tab can land on a panel (reka gives it tabindex 0), so the panel keeps the
// shared keyboard focus outline instead of upstream's outline-none.
describe('TabsContent', () => {
  it('stays reachable by Tab without hiding the focus outline', () => {
    const wrapper = mount(() => h(Tabs, { defaultValue: 'one' }, () => [
      h(TabsList, () => [h(TabsTrigger, { value: 'one' }, () => 'One')]),
      h(TabsContent, { value: 'one', class: 'settings-panel' }, () => 'Panel'),
    ]))
    const panel = wrapper.get('[role="tabpanel"]')
    expect(panel.attributes('tabindex')).toBe('0')
    expect(panel.classes()).not.toContain('outline-none')
    expect(panel.classes()).toContain('settings-panel')
    wrapper.unmount()
  })
})
