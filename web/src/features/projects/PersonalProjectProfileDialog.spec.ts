import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const putJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ putJson }))

import PersonalProjectProfileDialog from './PersonalProjectProfileDialog.vue'

describe('PersonalProjectProfileDialog', () => {
  beforeEach(() => {
    putJson.mockReset()
    putJson.mockResolvedValue({
      project_id: 'hotel-theme',
      personal_space_id: 'space-1',
      profile: { name: '酒店主题' },
    })
  })

  it('updates project material without rewriting it as a knowledge revision', async () => {
    const wrapper = mount(PersonalProjectProfileDialog, {
      props: {
        project: {
          project_id: 'hotel-theme',
          personal_space_id: 'space-1',
          profile: {
            name: '酒店主题',
            purpose: '旧目标',
            scope: '旧范围',
            technical_summary: '旧技术摘要',
            lifecycle: 'active',
            sources: [{
              key: 'prd',
              kind: 'prd',
              title: '产品文档',
              uri: 'file:///prd.md',
              sensitivity: 'private',
            }],
            boundaries: ['不处理预订流程'],
          },
        },
        materialType: 'ProjectPurpose',
      },
    })

    await wrapper.get('[name="project-purpose"]').setValue('新的项目目标')
    expect(wrapper.get('.project-source-wide-field input').attributes('maxlength')).toBe('2048')
    await wrapper.get('[name="project-boundaries"]').setValue(
      '不处理预订流程\n不修改支付系统\n不处理预订流程',
    )
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson).toHaveBeenCalledWith('/api/personal-projects', {
      personalSpaceId: 'space-1',
      projectId: 'hotel-theme',
      profile: expect.objectContaining({
        name: '酒店主题',
        purpose: '新的项目目标',
        scope: '旧范围',
        technicalSummary: '旧技术摘要',
        lifecycle: 'active',
        boundaries: ['不处理预订流程', '不修改支付系统'],
        sources: [{
          key: 'prd',
          kind: 'prd',
          title: '产品文档',
          uri: 'file:///prd.md',
          summary: null,
          sensitivity: 'private',
        }],
      }),
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
