import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { setLocale, t } from '@/i18n'
import AgentNamingStyleField from './AgentNamingStyleField.vue'

const ZH_DEFAULT = '像人一样的英文名：一个名加一个姓，比如 Lyra North、Milo Reed；不用职位名'

function mountField(modelValue: string) {
  const wrapper = mount(AgentNamingStyleField, {
    props: { modelValue, 'onUpdate:modelValue': (style: string) => wrapper.setProps({ modelValue: style }) },
  })
  return wrapper
}
const field = (wrapper: ReturnType<typeof mountField>) => wrapper.get<HTMLTextAreaElement>('[data-agent-naming-style]')
const reset = (wrapper: ReturnType<typeof mountField>) => wrapper.get('[data-agent-naming-reset]')
const emitted = (wrapper: ReturnType<typeof mountField>) => (wrapper.emitted('update:modelValue') ?? []).map(([style]) => style)

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('AgentNamingStyleField', () => {
  it('starts with FULI\'s default rule as editable text, short enough to keep', () => {
    const wrapper = mountField('')
    expect(field(wrapper).element.value).toBe(ZH_DEFAULT)
    expect(ZH_DEFAULT.length).toBeLessThanOrEqual(100)
    expect(wrapper.text()).toContain(`${ZH_DEFAULT.length} / 建议 100 字`)
    expect(reset(wrapper).attributes('disabled')).toBeDefined()
    expect(emitted(wrapper)).toEqual([])
  })

  it('saves an edited rule, and the default (typed back or restored) as no style', async () => {
    const wrapper = mountField('')
    await field(wrapper).setValue('用两个字的植物名')
    expect(wrapper.props('modelValue')).toBe('用两个字的植物名')
    expect(reset(wrapper).attributes('disabled')).toBeUndefined()

    await field(wrapper).setValue(` ${ZH_DEFAULT} `)
    expect(wrapper.props('modelValue')).toBe('')

    await field(wrapper).setValue('像北欧神话里的名字')
    await reset(wrapper).trigger('click')
    expect(field(wrapper).element.value).toBe(ZH_DEFAULT)
    expect(emitted(wrapper)).toEqual(['用两个字的植物名', '', '像北欧神话里的名字', ''])
  })

  it('shows a saved style and follows a new answer from the server', async () => {
    const wrapper = mountField('用两个字的植物名')
    expect(field(wrapper).element.value).toBe('用两个字的植物名')
    await wrapper.setProps({ modelValue: '' })
    expect(field(wrapper).element.value).toBe(ZH_DEFAULT)
    expect(emitted(wrapper)).toEqual([])
  })

  it('shows the untouched default in the console language', async () => {
    const wrapper = mountField('')
    setLocale('en-US', { persist: false })
    await nextTick()
    await nextTick()
    expect(field(wrapper).element.value).toBe(t('settings.agentNaming.default'))
    expect(field(wrapper).element.value).toContain('Lyra North')
    expect(emitted(wrapper)).toEqual([])
  })
})
