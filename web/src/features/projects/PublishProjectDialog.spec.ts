import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ postJson }))

import { useConsoleStore } from '@/stores/console'
import PublishProjectDialog from './PublishProjectDialog.vue'

describe('PublishProjectDialog', () => {
  beforeEach(() => {
    postJson.mockReset()
    postJson.mockResolvedValue({})
  })

  it('suggests the next release and publishes only explicit version notes', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'connected',
      activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      personalProjects: [],
      providers: {
        personal: { status: 'ready' },
        workspaces: [{ status: 'ready', providerUrl: 'https://provider.example' }],
      },
      projects: [{
        id: 'public-1',
        name: 'Fuli',
        providerUrl: 'https://provider.example',
        publication_key: 'publication-1',
        current_release: { version: 'v1.2.3' },
      }],
      subscriptions: [],
    }
    vi.spyOn(store, 'refresh').mockResolvedValue(undefined)
    const wrapper = mount(PublishProjectDialog, {
      props: {
        project: {
          project_id: 'fuli',
          personal_space_id: 'personal-1',
          publication_key: 'publication-1',
          profile: { name: 'Fuli' },
        },
      },
      global: { plugins: [pinia] },
    })

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('v1.2.4')
    await wrapper.get('textarea').setValue('迁移 Vue 图谱渲染器。')
    await wrapper.get('.primary-action').trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith('/api/projects/publish', {
      personalSpaceId: 'personal-1',
      localProjectId: 'fuli',
      providerUrl: 'https://provider.example',
      releaseVersion: 'v1.2.4',
      updateSummary: '迁移 Vue 图谱渲染器。',
    })
    expect(wrapper.emitted('published')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
