import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import CliPathSettings from './CliPathSettings.vue'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const server = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => json(body)))

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('shows the switch only on the desktop app, set to what FULI reports', async () => {
  server({ supported: true, enabled: false })
  const wrapper = mount(CliPathSettings)
  await flushPromises()
  expect(wrapper.get('[data-slot="card-title"]').text()).toBe('终端里的 fl / fuli')
  expect(wrapper.get('[data-cli-path-switch]').attributes('aria-checked')).toBe('false')
})

it('says nothing where the app has no commands to offer', async () => {
  server({ supported: false, enabled: false })
  const wrapper = mount(CliPathSettings)
  await flushPromises()
  expect(wrapper.find('[data-cli-path-settings]').exists()).toBe(false)
})
