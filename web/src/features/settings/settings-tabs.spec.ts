import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { router } from '@/router'
import { settingsTabFrom } from './settings-tabs'

describe('settings tabs', () => {
  // The app router scrolls to the top on a new path; jsdom has no scrolling.
  beforeAll(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
  afterAll(() => { vi.restoreAllMocks() })

  it('reads a current tab and falls back to recording for anything else', () => {
    expect(settingsTabFrom('connections')).toBe('connections')
    expect(settingsTabFrom('ai')).toBe('ai')
    expect(settingsTabFrom('memory')).toBe('recording')
    expect(settingsTabFrom(undefined)).toBe('recording')
  })

  it('sends an old tab to the tab that holds it now, keeping the rest of the link', async () => {
    await router.push('/settings?tab=memory&setting=capture')
    expect(router.currentRoute.value.fullPath).toBe('/settings?tab=recording&setting=capture')
    await router.push('/settings?tab=network#ports')
    expect(router.currentRoute.value.fullPath).toBe('/settings?tab=connections#ports')
    // The version is a section of 系统 now: the link opens there at the version card.
    await router.push('/settings?tab=version')
    expect(router.currentRoute.value.fullPath).toBe('/settings?tab=system#version')
    await router.push('/settings?tab=clients#npm-copies')
    expect(router.currentRoute.value.fullPath).toBe('/settings?tab=clients#npm-copies')
  })

  it('opens the connections tab from the old connections page, and models from the old models path', async () => {
    await router.push('/connections')
    expect(router.currentRoute.value.fullPath).toBe('/settings?tab=connections')
    await router.push('/settings/models')
    expect(router.currentRoute.value.fullPath).toBe('/models')
  })
})
