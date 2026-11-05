import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersonalProject } from '@/types'
import DreamingCard from './DreamingCard.vue'
import { readDreaming, startDreaming } from './dreaming'

vi.mock('./dreaming', () => ({ readDreaming: vi.fn(), startDreaming: vi.fn() }))

const project = { project_id: 'alpha', scope_type: 'formal', profile: { name: 'Synthetic Alpha' } } as unknown as PersonalProject

describe('DreamingCard', () => {
  beforeEach(() => { vi.mocked(readDreaming).mockReset(); vi.mocked(startDreaming).mockReset() })

  it('says a model is needed and offers no run without one', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'needs_model', runs: [] })
    const wrapper = mount(DreamingCard, { props: { projects: [project] } })
    await flushPromises()
    expect(wrapper.find('[data-dreaming-needs-model]').exists()).toBe(true)
    expect(wrapper.find('[data-dreaming-run]').exists()).toBe(false)
  })

  it('runs the chosen project and shows what it found', async () => {
    vi.mocked(readDreaming).mockResolvedValueOnce({ readiness: 'ready', runs: [] })
      .mockResolvedValue({ readiness: 'ready', runs: [{ at: '2026-11-05T00:00:00Z', personalProjectId: 'alpha', status: 'dreamed', sessions: 4,
        proposed: [{ action: 'add', seenIn: 3, status: 'queued' }] }] })
    vi.mocked(startDreaming).mockResolvedValue({ status: 'dreamed' })
    const wrapper = mount(DreamingCard, { props: { projects: [project] } })
    await flushPromises()
    await wrapper.get('[data-dreaming-run]').trigger('click')
    await flushPromises()
    expect(startDreaming).toHaveBeenCalledWith('alpha')
    expect(wrapper.text()).toContain('Synthetic Alpha')
    expect(wrapper.text()).toContain('看了 4 个会话，提了 1 条建议')
  })
})
