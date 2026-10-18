import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
const engine = vi.hoisted(() => ({ controls: null as any, render: vi.fn() }))
vi.mock('three', async original => ({ ...await original<typeof import('three')>(), WebGLRenderer: class {
  domElement = document.createElement('canvas'); shadowMap = {}; setPixelRatio() {} setSize() {} dispose() {} render = engine.render
} }))
vi.mock('three/examples/jsm/renderers/CSS2DRenderer.js', () => ({ CSS2DRenderer: class { domElement = document.createElement('div'); setSize() {} render() {} }, CSS2DObject: class {} }))
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({ OrbitControls: class extends EventTarget {
  target = new THREE.Vector3(); enableDamping = false; autoRotate = false
  constructor() { super(); engine.controls = this } update() {} dispose() {}
} }))
import { createStage } from './stage'
describe('live reduced motion in the actual stage loop', () => {
  it('stops frames and damping for root and system changes, resumes without auto rotation, and removes listeners', async () => {
    const media = new EventTarget() as MediaQueryList & { matches: boolean }
    Object.defineProperty(media, 'matches', { value: false, writable: true })
    vi.stubGlobal('matchMedia', () => media)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const raf = vi.fn(() => 42), cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf); vi.stubGlobal('cancelAnimationFrame', cancel)
    const host = document.createElement('div'); document.body.append(host)
    const stage = createStage({ container: host, camera: new THREE.PerspectiveCamera(), reducedMotion: false, onPick() {}, controls: { minDistance: 1, maxDistance: 10, minPolar: 0, maxPolar: 1 } })
    expect(engine.controls.enableDamping).toBe(true)
    document.documentElement.dataset.motion = 'reduced'
    await Promise.resolve()
    expect(engine.controls.enableDamping).toBe(false)
    expect(cancel).toHaveBeenCalledWith(42)
    delete document.documentElement.dataset.motion; await Promise.resolve()
    Object.defineProperty(media, 'matches', { value: true })
    media.dispatchEvent(new Event('change'))
    expect(engine.controls.enableDamping).toBe(false)
    expect(engine.controls.autoRotate).toBe(false)
    stage.dispose()
    const count = raf.mock.calls.length
    Object.defineProperty(media, 'matches', { value: false }); media.dispatchEvent(new Event('change'))
    expect(raf).toHaveBeenCalledTimes(count)
    vi.unstubAllGlobals()
  })
})
