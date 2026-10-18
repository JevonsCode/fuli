import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { fitView } from './framing'
import { MAX_SCENE_AGENTS, MAX_SCENE_PROJECTS, officeLayout, type SceneProject } from './layout'
import { officeFrame } from './office-frame'

const project = (id: string, agents: number): SceneProject => ({
  id, name: id,
  agents: Array.from({ length: agents }, (_, index) => ({ id: `${id}-${index}`, name: `A${index}`, state: 'running' as const, color: null, href: `/t/${id}-${index}` })),
})
const fullOffice = officeLayout(Array.from({ length: MAX_SCENE_PROJECTS }, (_, index) => project(`p${index}`, MAX_SCENE_AGENTS)))

describe('office framing', () => {
  // Round 19: in a tall narrow stage the distance search for a full office
  // doubled past the far plane (124 → 248 > 200) and then searched forever.
  it.each([[280, 620], [240, 640]])('fits a full office in a %i×%i stage and keeps it inside the far plane', (width, height) => {
    const { camera, points } = officeFrame(fullOffice)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    const fit = fitView(camera, new THREE.Vector3(), points)
    expect(fit).not.toBeNull()
    const { target, distance, reach } = fit!
    camera.position.normalize().multiplyScalar(distance).add(target)
    camera.lookAt(target)
    camera.far = distance + reach
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    const projected = points.map(point => point.clone().project(camera))
    expect(projected.every(point => Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z < 1)).toBe(true)
  })
})
