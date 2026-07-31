import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ postJson }))

import { knowledgeItemFromNode } from '@/features/knowledge/model'
import { useConsoleStore } from '@/stores/console'
import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import KnowledgeProjectDialog from './KnowledgeProjectDialog.vue'

describe('KnowledgeProjectDialog', () => {
  beforeEach(() => {
    postJson.mockReset()
    postJson.mockImplementation((url: string) => {
      if (url.endsWith('/preview')) {
        return Promise.resolve({
          item_name: '发布规则',
          item_summary: '必须审核',
          match: {
            kind: 'conflict',
            reason: '同名内容不同',
            item_name: '发布规则',
            item_summary: '可以直接发布',
          },
        })
      }
      return Promise.resolve({ status: 'conflict_pending' })
    })
  })

  it('preserves the source relation and defers a detected project conflict by default', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      personalProjects: [],
      projects: [],
      subscriptions: [],
    }
    const item = knowledgeItemFromNode({
      id: 'entity-1',
      name: '发布规则',
      type: 'Decision',
      summary: '必须审核',
      assignments: [{ project_id: 'project-b' }],
    })
    const wrapper = mount(KnowledgeProjectDialog, {
      props: {
        item,
        personalSpaceId: 'personal-1',
        personalProjectId: 'project-b',
        projects: [
          {
            project_id: 'project-a',
            personal_space_id: 'personal-1',
            profile: { name: 'A 项目' },
          },
          {
            project_id: 'project-b',
            personal_space_id: 'personal-1',
            profile: { name: 'B 项目' },
          },
        ],
      },
      global: {
        plugins: [pinia],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })

    expect((wrapper.get('.knowledge-project-relation input').element as HTMLInputElement).checked)
      .toBe(true)
    await wrapper.get('input[value="existing"]').setValue(true)
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith(
      '/api/knowledge/entity/entity-1/project-action/preview',
      {
        personalSpaceId: 'personal-1',
        targetProjectId: 'project-a',
      },
    )
    expect(wrapper.get('.knowledge-project-conflict-options').text()).toContain(
      '暂不采用，保留待处理记录',
    )

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith(
      '/api/knowledge/entity/entity-1/project-action',
      expect.objectContaining({
        personalSpaceId: 'personal-1',
        mode: 'existing',
        targetProjectId: 'project-a',
        keepSourceRelation: true,
        relationType: 'RELATED_TO',
        conflictResolution: 'defer',
      }),
    )
    expect(wrapper.emitted('saved')).toEqual([
      [{ status: 'conflict_pending' }, 'A 项目'],
    ])
  })
})
