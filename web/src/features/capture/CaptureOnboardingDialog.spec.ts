import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import type { CapturePolicy } from '@/types'
import CaptureOnboardingDialog from './CaptureOnboardingDialog.vue'

const PROJECTS = [
  { project_id: 'thesis', personal_space_id: 'space', profile: { name: '毕业论文' } },
  { project_id: 'novel', personal_space_id: 'space', profile: { name: '小说连载' } },
  { project_id: 'scratch', personal_space_id: 'space', scope_type: 'temporary' as const, profile: { name: '临时' } },
]
const OFF: CapturePolicy = { enabled: false, projectMode: 'all', updatedAt: '2026-10-21T08:00:00.000Z' }

function mountDialog({ ask = true, projects = PROJECTS, answer }: {
  ask?: boolean
  projects?: typeof PROJECTS
  answer: (body: Record<string, unknown>) => Promise<Response>
}) {
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/api/capture-policy') return Response.json(OFF)
    if (input !== '/api/capture-onboarding' || init?.method !== 'POST') return Response.json({}, { status: 404 })
    const body = JSON.parse(String(init.body))
    posts.push(body)
    return answer(body)
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.state = { mode: 'personal_only', personalSpaces: [{ id: 'space', name: '我' }], activePersonalSpaceId: 'space',
    projects: [], subscriptions: [], personalProjects: projects, capturePolicy: OFF, captureOnboarding: { ask } }
  const wrapper = mount(CaptureOnboardingDialog, { global: { plugins: [pinia] }, attachTo: document.body })
  return { wrapper, posts, store }
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-capture-onboarding]')
const find = (selector: string) => document.body.querySelector<HTMLElement>(selector)
async function click(selector: string) {
  find(selector)!.click()
  await flushPromises()
}

describe('CaptureOnboardingDialog (rec#5 C10)', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  it('asks "FULI 要在哪些项目里记录？" with three choices and nothing preselected', async () => {
    const { wrapper } = mountDialog({ answer: async () => Response.json({}) })
    await flushPromises()
    expect(dialog()?.querySelector('h2')?.textContent).toBe('FULI 要在哪些项目里记录？')
    const options = [...document.body.querySelectorAll<HTMLElement>('[data-capture-scope]')]
    expect(options.map(option => [option.dataset.captureScope, option.querySelector('strong')?.textContent]))
      .toEqual([['all', '全部项目'], ['selected', '只记我选的项目'], ['off', '先不记录']])
    expect(document.body.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0)
    expect(find('[data-capture-scope-save]')!.hasAttribute('disabled')).toBe(true)
    wrapper.unmount()
  })

  it('C10-1 saves only the ticked projects with an inline pending state', async () => {
    let respond!: (response: Response) => void
    const { wrapper, posts, store } = mountDialog({ answer: () => new Promise(resolve => { respond = resolve }) })
    await flushPromises()
    await click('[data-capture-scope="selected"] [role="radio"]')
    const listed = [...document.body.querySelectorAll<HTMLElement>('[data-capture-scope-project]')].map(row => row.dataset.captureScopeProject)
    expect(listed).toEqual(['thesis', 'novel'])
    await click('[data-capture-scope-project="thesis"] [role="checkbox"]')
    await click('[data-capture-scope-save]')
    expect(posts).toEqual([{ choice: 'selected', selectedProjectIds: ['thesis'] }])
    expect(find('[data-capture-scope-save]')!.getAttribute('aria-busy')).toBe('true')
    expect(find('[data-capture-scope-save] [aria-label="正在保存记录范围"]')).not.toBeNull()
    const saved = { enabled: true, projectMode: 'selected', selectedProjectIds: ['thesis'], unregisteredDirectories: 'skip' }
    respond(Response.json({ status: 'answered', choice: 'selected', capturePolicy: saved }))
    await flushPromises()
    expect(store.state?.capturePolicy).toEqual(saved)
    expect(store.state?.captureOnboarding).toEqual({ ask: false })
    expect(store.feedback?.message).toBe('已设为只记录勾选的项目，可以在设置里随时改。')
    expect(dialog()).toBeNull()
    wrapper.unmount()
  })

  it('C10-1 with no project yet, says how a project starts being recorded', async () => {
    const { wrapper } = mountDialog({ projects: [], answer: async () => Response.json({}) })
    await flushPromises()
    await click('[data-capture-scope="selected"] [role="radio"]')
    expect(find('[data-capture-scope-projects]')?.textContent).toContain('记忆这个项目')
    wrapper.unmount()
  })

  it('C10-3 "先不记录" saves recording off and says where to turn it on', async () => {
    const { wrapper, posts, store } = mountDialog({ answer: async () => Response.json({ status: 'answered', choice: 'off',
      capturePolicy: { ...OFF, updatedAt: '2026-10-21T08:01:00.000Z' } }) })
    await flushPromises()
    await click('[data-capture-scope="off"] [role="radio"]')
    await click('[data-capture-scope-save]')
    expect(posts).toEqual([{ choice: 'off' }])
    expect(store.feedback?.message).toBe('记录已关闭，可以在设置里随时打开。')
    wrapper.unmount()
  })

  it('"稍后再选" closes without saving anything; recording stays off', async () => {
    const { wrapper, posts, store } = mountDialog({ answer: async () => Response.json({}) })
    await flushPromises()
    await click('[data-capture-scope="all"] [role="radio"]')
    await click('[data-capture-scope-later]')
    expect(dialog()).toBeNull()
    expect(posts).toEqual([])
    // The console asks again the next time it opens.
    expect(store.state?.captureOnboarding).toEqual({ ask: true })
    wrapper.unmount()
  })

  it('answered elsewhere meanwhile: closes and shows the saved settings', async () => {
    const { wrapper, store } = mountDialog({ answer: async () => Response.json({ status: 'gone' }) })
    await flushPromises()
    await click('[data-capture-scope="all"] [role="radio"]')
    await click('[data-capture-scope-save]')
    expect(dialog()).toBeNull()
    expect(store.feedback?.message).toBe('记录范围已经选过，或记录设置已经改动，下面按已保存的设置显示。')
    wrapper.unmount()
  })

  it('a failed save keeps the question open and says recording stays off', async () => {
    const { wrapper } = mountDialog({ answer: async () => Response.json({ error: 'disk full' }, { status: 500 }) })
    await flushPromises()
    await click('[data-capture-scope="all"] [role="radio"]')
    await click('[data-capture-scope-save]')
    expect(dialog()).not.toBeNull()
    expect(find('[data-capture-scope-error]')?.textContent).toContain('没能保存，记录仍然关闭')
    wrapper.unmount()
  })

  it('an installation that existed before is never asked', async () => {
    const { wrapper } = mountDialog({ ask: false, answer: async () => Response.json({}) })
    await flushPromises()
    expect(dialog()).toBeNull()
    wrapper.unmount()
  })
})
