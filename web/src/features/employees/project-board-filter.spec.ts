import { defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectBoardFilterKey, useProjectBoardFilter } from './project-board-filter'

// Synthetic spaces and projects: no real project preferences or business data are touched.
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => localStorage.clear())
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })

async function setup(path = '/employees/jefa?project=all', initiallyReady = true) {
  const enabled = ref(true)
  const spaceId = ref('space-a')
  const projectIds = ref(['alpha', 'beta', 'gamma'])
  const ready = ref(initiallyReady)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/employees/:id', component: { template: '<div />' } }] })
  await router.push(path)
  let filter!: ReturnType<typeof useProjectBoardFilter>
  const wrapper = mount(defineComponent({
    setup() { filter = useProjectBoardFilter({ enabled, spaceId, projectIds, ready }); return () => null },
  }), { global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { filter, router, wrapper, enabled, spaceId, projectIds, ready }
}
const saved = (space = 'space-a') => JSON.parse(localStorage.getItem(projectBoardFilterKey(space)) ?? 'null')

describe('Jefa project filter persistence', () => {
  it('defaults to every project, including newly added ones, without saving a snapshot', async () => {
    const { filter, projectIds } = await setup('/employees/jefa')
    expect(filter.selection.value).toEqual(['alpha', 'beta', 'gamma'])
    projectIds.value.push('delta')
    await flushPromises()
    expect(filter.selection.value).toContain('delta')
    expect(saved()).toBeNull()
  })

  it('migrates an existing URL selection, keeps it on sidebar navigation, and restores on reopen', async () => {
    const first = await setup('/employees/jefa?project=alpha&project=gamma&search=keep')
    expect(saved().projectIds).toEqual(['alpha', 'gamma'])
    await first.router.push('/employees/jefa?project=all&search=keep')
    await flushPromises()
    expect(first.filter.selection.value).toEqual(['alpha', 'gamma'])
    expect(first.router.currentRoute.value.query.search).toBe('keep')
    first.wrapper.unmount()
    const reopened = await setup('/employees/jefa?project=beta')
    expect(reopened.filter.selection.value).toEqual(['alpha', 'gamma'])
  })

  it('persists changes and even no selection, and resets to dynamic all projects', async () => {
    const first = await setup()
    first.filter.selection.value = ['beta']
    await flushPromises()
    expect(saved().projectIds).toEqual(['beta'])
    first.filter.selection.value = []
    await flushPromises()
    expect(first.router.currentRoute.value.query.empty).toBe('1')
    first.wrapper.unmount()
    const reopened = await setup()
    expect(reopened.filter.selection.value).toEqual([])
    reopened.filter.reset()
    await flushPromises()
    expect(saved()).toBeNull()
    expect(reopened.router.currentRoute.value.query).toEqual({ project: 'all' })
    reopened.projectIds.value.push('delta')
    expect(reopened.filter.selection.value).toContain('delta')
  })

  it('reset clears a saved full snapshot and its explicit URL too', async () => {
    const { filter, router } = await setup('/employees/jefa?project=alpha&project=beta&project=gamma')
    expect(saved()).not.toBeNull()
    filter.reset()
    await flushPromises()
    expect(router.currentRoute.value.query.project).toBe('all')
    expect(saved()).toBeNull()
  })

  it('waits for the successful catalog before importing a link, including an empty filter', async () => {
    const state = await setup('/employees/jefa?project=alpha', false)
    state.projectIds.value = []
    await flushPromises()
    expect(saved()).toBeNull()
    state.projectIds.value = ['alpha', 'beta']
    state.ready.value = true
    await flushPromises()
    expect(state.filter.selection.value).toEqual(['alpha'])
    expect(saved().projectIds).toEqual(['alpha'])
  })

  it('retains unavailable selected projects without selecting new ones during refresh', async () => {
    const state = await setup('/employees/jefa?project=alpha&project=gamma')
    state.ready.value = false
    state.projectIds.value = []
    await flushPromises()
    expect(saved().projectIds).toEqual(['alpha', 'gamma'])
    state.projectIds.value = ['alpha', 'beta', 'delta']
    state.ready.value = true
    await flushPromises()
    expect(state.filter.selection.value).toEqual(['alpha'])
    state.filter.selection.value = ['beta']
    state.projectIds.value.push('gamma')
    await flushPromises()
    expect(state.filter.selection.value).toEqual(['beta', 'gamma'])
    expect(state.filter.invalidScope.value).toBe(false)
  })

  it('does not migrate an invalid link or silently show a different scope', async () => {
    const state = await setup('/employees/jefa?project=unknown')
    expect(state.filter.invalidScope.value).toBe(true)
    expect(saved()).toBeNull()
    await state.router.push('/employees/jefa?project=beta')
    await flushPromises()
    expect(state.filter.invalidScope.value).toBe(false)
    expect(state.filter.selection.value).toEqual(['beta'])
  })

  it('isolates spaces and does not import the previous space’s URL on a space change', async () => {
    const state = await setup('/employees/jefa?project=alpha')
    state.spaceId.value = 'space-b'
    await flushPromises()
    expect(state.filter.selection.value).toEqual(['alpha', 'beta', 'gamma'])
    expect(saved('space-b')).toBeNull()
    state.filter.selection.value = ['beta']
    state.spaceId.value = 'space-a'
    await flushPromises()
    expect(state.filter.selection.value).toEqual(['alpha'])
    expect(saved('space-b').projectIds).toEqual(['beta'])
  })

  it('recovers corrupt storage and reports denied writes without breaking the current filter', async () => {
    localStorage.setItem(projectBoardFilterKey('space-a'), '{broken')
    const { filter } = await setup()
    expect(filter.storageUnavailable.value).toBe(false)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    filter.selection.value = ['beta']
    await flushPromises()
    expect(filter.selection.value).toEqual(['beta'])
    expect(filter.storageUnavailable.value).toBe(true)
  })

  it('does not use or change the preference on another specialist panel', async () => {
    const state = await setup('/employees/jefa?project=alpha')
    state.enabled.value = false
    await state.router.push('/employees/reviewer?project=beta')
    await flushPromises()
    expect(state.router.currentRoute.value.query.project).toBe('beta')
    expect(saved().projectIds).toEqual(['alpha'])
  })

  it('lets newer navigation cancel a delayed filter URL update', async () => {
    const state = await setup()
    let release!: () => void
    let entered = false
    const delayed = new Promise<void>(resolve => { release = resolve })
    state.router.beforeResolve(async to => {
      if ([to.query.project].flat().includes('alpha')) { entered = true; await delayed }
    })
    state.filter.selection.value = ['alpha']
    await flushPromises()
    expect(entered).toBe(true)
    state.enabled.value = false
    await state.router.push('/employees/reviewer?project=beta')
    release()
    await flushPromises()
    expect(state.router.currentRoute.value.fullPath).toBe('/employees/reviewer?project=beta')
  })

  it('normalizes duplicate sentinel parameters without widening a malformed empty selection', async () => {
    const empty = await setup('/employees/jefa?empty=1&empty=0')
    expect(empty.filter.selection.value).toEqual([])
    expect(empty.router.currentRoute.value.query.empty).toBe('1')
    empty.wrapper.unmount()
    localStorage.clear()
    const all = await setup('/employees/jefa?project=all&project=all')
    expect(all.filter.invalidScope.value).toBe(false)
    expect(all.router.currentRoute.value.query.project).toBe('all')
  })
})
