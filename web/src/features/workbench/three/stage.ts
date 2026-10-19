import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { fitView } from './framing'

// One WebGL stage for every 3D workbench design: renderer, soft-shadow
// lighting defaults, crisp HTML labels, gentle orbit controls, click picking,
// resize and teardown. A scene only adds its objects and per-frame motion.

export interface StageOptions {
  container: HTMLElement
  camera: THREE.PerspectiveCamera
  /** Under reduced motion the stage renders on demand and never animates. */
  reducedMotion: boolean
  target?: THREE.Vector3
  onPick: (href: unknown) => void
  controls?: { minDistance: number; maxDistance: number; minPolar: number; maxPolar: number; autoRotate?: boolean }
  /**
   * Refit on every resize so these points fill the view; the camera keeps its
   * direction and the zoom limits are fractions of the fitted distance.
   */
  frame?: { points: THREE.Vector3[]; zoomIn: number; zoomOut: number }
}

export interface Stage {
  scene: THREE.Scene
  /** Per-frame hooks; elapsed seconds since the stage started. */
  onFrame: (step: (elapsed: number) => void) => void
  render: () => void
  dispose: () => void
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(window.WebGL2RenderingContext && canvas.getContext('webgl2'))
  } catch {
    return false
  }
}

/** A token colour from the page, so the scene follows the chosen palette (white if unset). */
export function tokenColor(element: HTMLElement, name: string): THREE.Color {
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  try { return value ? new THREE.Color(value) : new THREE.Color(1, 1, 1) } catch { return new THREE.Color(1, 1, 1) }
}

/** A colour given as a CSS value, including var(--token), resolved against the page. */
export function cssColor(element: HTMLElement, value: string | null | undefined, fallbackToken: string): THREE.Color {
  const token = value?.match(/^var\((--[\w-]+)\)$/)?.[1]
  return tokenColor(element, token ?? fallbackToken)
}

/** An HTML label that stays sharp at any zoom; `className` styles it from Vue CSS. */
export function label(text: string, className: string): CSS2DObject {
  const element = document.createElement('div')
  element.className = className
  element.textContent = text
  return new CSS2DObject(element)
}

export function createStage(options: StageOptions): Stage {
  const { container, camera } = options
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  const motionState = () => document.documentElement.dataset.motion === 'reduced' || Boolean(media?.matches)
  let reducedMotion = options.reducedMotion || motionState()
  let disposed = false
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  const labels = new CSS2DRenderer()
  labels.domElement.className = 'stage-labels'
  container.appendChild(labels.domElement)

  const scene = new THREE.Scene()
  const controls = new OrbitControls(camera, labels.domElement)
  controls.enablePan = false
  controls.enableDamping = !reducedMotion
  controls.dampingFactor = 0.08
  controls.target.copy(options.target ?? new THREE.Vector3())
  if (options.controls) {
    controls.minDistance = options.controls.minDistance
    controls.maxDistance = options.controls.maxDistance
    controls.minPolarAngle = options.controls.minPolar
    controls.maxPolarAngle = options.controls.maxPolar
    controls.autoRotate = Boolean(options.controls.autoRotate) && !reducedMotion
    controls.autoRotateSpeed = 0.35
  }

  const steps: ((elapsed: number) => void)[] = []
  const clock = new THREE.Clock()
  let frame = 0
  const render = () => {
    controls.update()
    renderer.render(scene, camera)
    labels.render(scene, camera)
    // Labels are optional projections. Suppress collisions while the semantic
    // list retains every project/member and its full name.
    const bounds = container.getBoundingClientRect()
    const occupied: DOMRect[] = []
    for (const element of labels.domElement.querySelectorAll<HTMLElement>('.stage-label--project, .stage-label--planet')) {
      element.style.visibility = ''
      const rect = element.getBoundingClientRect()
      const overlaps = occupied.some(other => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)
      const outside = rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom
      if (overlaps || outside) element.style.visibility = 'hidden'
      else occupied.push(rect)
    }
  }
  const loop = () => {
    frame = requestAnimationFrame(loop)
    const elapsed = clock.getElapsedTime()
    for (const step of steps) step(elapsed)
    render()
  }
  const onChange = () => { if (reducedMotion && !disposed) render() }
  controls.addEventListener('change', onChange)
  function updateMotion() {
    const next = motionState()
    if (next === reducedMotion || disposed) return
    reducedMotion = next
    controls.enableDamping = !next
    // Switching a preference never starts automatic rotation.
    controls.autoRotate = false
    cancelAnimationFrame(frame)
    frame = 0
    if (next) render()
    else loop()
  }
  media?.addEventListener('change', updateMotion)
  const motionObserver = new MutationObserver(updateMotion)
  motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })

  const baseFar = camera.far
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = container
    if (!width || !height) return
    camera.aspect = width / height
    // Without a fit the camera keeps its current (starting) framing.
    const fit = options.frame && fitView(camera, controls.target, options.frame.points)
    if (options.frame && fit) {
      const { zoomIn, zoomOut } = options.frame
      const { target, distance, reach } = fit
      const direction = camera.position.clone().sub(controls.target).normalize()
      controls.target.copy(target)
      camera.position.copy(target).addScaledVector(direction, distance)
      controls.minDistance = distance * zoomIn
      controls.maxDistance = distance * zoomOut
      // Fully zoomed out, the farthest framed point still lies inside the far plane.
      camera.far = Math.max(baseFar, distance * zoomOut + reach)
    }
    camera.updateProjectionMatrix()
    renderer.setSize(width, height)
    labels.setSize(width, height)
    if (reducedMotion) render()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()

  // A click (not a drag) on an object with userData.href opens it.
  const pointer = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  let down: { x: number; y: number } | null = null
  const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY } }
  const onUp = (event: PointerEvent) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) { down = null; return }
    down = null
    const rect = labels.domElement.getBoundingClientRect()
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    for (const hit of raycaster.intersectObjects(scene.children, true)) {
      let node: THREE.Object3D | null = hit.object
      while (node && node.userData.href === undefined) node = node.parent
      if (node) { options.onPick(node.userData.href); return }
    }
  }
  labels.domElement.addEventListener('pointerdown', onDown)
  labels.domElement.addEventListener('pointerup', onUp)

  if (!reducedMotion) loop()
  else render()

  return {
    scene,
    onFrame: step => { steps.push(step) },
    render,
    dispose() {
      disposed = true
      motionObserver.disconnect()
      media?.removeEventListener('change', updateMotion)
      controls.removeEventListener('change', onChange)
      cancelAnimationFrame(frame)
      observer.disconnect()
      labels.domElement.removeEventListener('pointerdown', onDown)
      labels.domElement.removeEventListener('pointerup', onUp)
      controls.dispose()
      scene.traverse(object => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose?.()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        for (const item of Array.isArray(material) ? material : material ? [material] : []) item.dispose()
      })
      renderer.dispose()
      renderer.domElement.remove()
      labels.domElement.remove()
    },
  }
}
