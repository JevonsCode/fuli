import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
const scene = vi.hoisted(() => ({ available: false, mount: vi.fn(), dispose: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('./ConstellationBoard.vue', () => ({ default: { template: '<div data-workbench="constellation" />' } }))
vi.mock('./three/stage', () => ({ webglAvailable: () => scene.available }))
vi.mock('./three/office-scene', () => ({ mountOffice: scene.mount }))
import Workbench3D from './Workbench3D.vue'
import type { WorkbenchBoard } from './workbench-board'
const board = { personalSpaceId: 's', tasks: [{ taskId: 't', title: 'Synthetic work', status: 'running', personalProjectId: 'p', leadAgentId: 'a', participants: [] }], attention: [],
  projectName: () => 'Synthetic project', agentFace: () => ({ name: 'Synthetic owner', color: null }), taskHref: () => '/task/t', questionHref: () => '/inbox', statusLabel: (s: string) => s, since: () => 'now' } as unknown as WorkbenchBoard
afterEach(() => { scene.mount.mockReset(); scene.dispose.mockReset() })
describe('optional office lifecycle', () => {
  it('reports WebGL failure to the page semantic list rather than replacing it with a star map', async () => {
    scene.available = false
    const wrapper = mount(Workbench3D, { props: { board, scene: 'office' } })
    await flushPromises()
    expect(wrapper.emitted('fallback')).toHaveLength(1)
    expect(wrapper.find('[data-workbench="constellation"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('disposes the mounted scene and reports context loss', async () => {
    scene.available = true
    const canvas = document.createElement('canvas')
    scene.mount.mockImplementation((host: HTMLElement) => { host.append(canvas); return { dispose: scene.dispose } })
    const wrapper = mount(Workbench3D, { props: { board, scene: 'office' } })
    await flushPromises()
    canvas.dispatchEvent(new Event('webglcontextlost', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('fallback')).toHaveLength(1)
    expect(scene.dispose).toHaveBeenCalled()
    wrapper.unmount()
  })
  it('invalidates a late module when leaving the view', async () => {
    scene.available = true
    const wrapper = mount(Workbench3D, { props: { board, scene: 'office' } })
    wrapper.unmount()
    await flushPromises()
    expect(scene.mount).not.toHaveBeenCalled()
  })
})
