import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it } from 'vitest'

import ServiceLog from '@/features/agent-services/ServiceLog.vue'
import WorkbenchTimeline from '@/features/overview/WorkbenchTimeline.vue'
import { findTerm } from '@/features/glossary/terms'
import { setLocale } from '@/i18n'
import MeLink from './MeLink.vue'

function preferencesRouter() {
  return createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/preferences', name: 'personal-profile', component: { template: '<div />' } },
  ] })
}

describe('MeLink', () => {
  it('names the current person 我 / Me as a quiet, focusable link to their preferences', () => {
    const wrapper = mount(MeLink)
    const link = wrapper.get('a')
    expect(link.text()).toBe('我')
    expect(link.attributes('href')).toBe('/preferences?aspect=taste')
    expect(link.attributes('aria-label')).toBe('我的偏好')
    expect(link.attributes('tabindex')).toBeUndefined()
    setLocale('en-US', { persist: false })
    const english = mount(MeLink).get('a')
    expect(english.text()).toBe('Me')
    expect(english.attributes('aria-label')).toBe('My preferences')
  })

  it('opens the taste view of 偏好 inside the console, and the glossary explains it', async () => {
    const router = preferencesRouter()
    await router.push('/')
    const wrapper = mount(MeLink, { attachTo: document.body, global: { plugins: [router] } })
    await wrapper.get('a').trigger('click', { button: 0 })
    await router.isReady()
    await new Promise(resolve => setTimeout(resolve))
    expect(router.currentRoute.value.name).toBe('personal-profile')
    expect(router.currentRoute.value.query.aspect).toBe('taste')
    expect(findTerm(wrapper.get('a').element)?.term.id).toBe('concept.me')
  })

  it('is what an actor label renders for the person, not for an Agent or FULI', () => {
    const log = mount(ServiceLog, { props: { loading: false, error: '', name: 'svc', log: { serviceId: 'svc', liveOutput: null, entries: [
      { id: 1, at: '2026-10-27T08:00:00Z', action: 'registered', actor: 'person', detail: null },
      { id: 2, at: '2026-10-27T08:01:00Z', action: 'registered', actor: 'fuli', detail: null },
    ] } } })
    const [person, fuli] = log.findAll('[data-service-log-entry]')
    expect(person!.findComponent(MeLink).exists()).toBe(true)
    expect(fuli!.findComponent(MeLink).exists()).toBe(false)
    expect(fuli!.text()).toContain('FULI')

    const timeline = mount(WorkbenchTimeline, { props: { taskKey: 'task', agentName: () => 'Ada', entries: [
      { id: 'a', at: '2026-10-27T08:00:00Z', actorKind: 'human', agentId: null, crew: [], tone: 'plain', reason: { text: 'Synthetic step', unknownCode: null, raw: null } },
    ] } })
    expect(timeline.get('.timeline-actor').findComponent(MeLink).exists()).toBe(true)
  })
})
