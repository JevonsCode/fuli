import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { describe, expect, it } from 'vitest'

import type { WritingTasteProfile } from '@/types'
import WritingTasteMilestone from './WritingTasteMilestone.vue'

const RouterLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  template: '<a class="router-link-stub" :data-to="to"><slot /></a>',
})

describe('WritingTasteMilestone', () => {
  it('shows collection progress without revealing the profile entry', () => {
    const wrapper = mount(WritingTasteMilestone, {
      props: { profile: writingTasteProfile('collecting') },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })

    expect(wrapper.text()).toContain('写作偏好正在形成')
    expect(wrapper.text()).toContain('2/3 条规则')
    expect(wrapper.find('.router-link-stub').exists()).toBe(false)
  })

  it('reveals the profile entry only after readiness is reached', () => {
    const wrapper = mount(WritingTasteMilestone, {
      props: { profile: writingTasteProfile('preview_ready') },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })

    expect(wrapper.text()).toContain('你的写作偏好初稿已形成')
    expect(wrapper.get('.router-link-stub').attributes('data-to'))
      .toBe('/preferences/writing')
  })
})

function writingTasteProfile(
  status: WritingTasteProfile['status'],
): WritingTasteProfile {
  const ready = status !== 'collecting'
  return {
    status,
    ready,
    generated_at: '2026-08-05T00:00:00.000Z',
    generated_from: 'personal_profile_graph',
    scope: { personal_space_id: 'personal-space', personal_project_id: null },
    readiness: {
      rule_count: ready ? 3 : 2,
      evidence_count: ready ? 6 : 2,
      session_count: ready ? 3 : 1,
      observation_day_count: ready ? 3 : 1,
      confirmed_rule_count: 0,
      observed_rule_count: ready ? 3 : 1,
      working_hypothesis_count: ready ? 0 : 1,
      conflict_count: 0,
      standard_path_ready: ready,
      confirmed_path_ready: false,
      thresholds: {
        rule_count: 3,
        evidence_count: 6,
        session_count: 3,
        observation_day_count: 3,
        confirmed_rule_count: 3,
      },
      criteria: [],
    },
    conflicts: [],
    rules: [],
    skill_name: ready ? 'user-writing-taste' : null,
    skill_version: ready ? 'v1:test' : null,
    profile_markdown: ready ? '# User Writing Taste' : null,
    agent_markdown: ready ? '# Agent View' : null,
  }
}
