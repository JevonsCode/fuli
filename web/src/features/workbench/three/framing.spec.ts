import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { boxCorners, fitDistance, fitView } from './framing'

const floor = new THREE.Box3(new THREE.Vector3(-8, 0, -5), new THREE.Vector3(8, 2, 5))
const cameraAt = (aspect: number) => {
  const camera = new THREE.PerspectiveCamera(30, aspect, 0.1, 500)
  camera.position.set(0, 0.82, 1.12)
  return camera
}

describe('fitDistance', () => {
  it('moves the camera back in a narrow stage and keeps every corner in view', () => {
    const target = new THREE.Vector3()
    const wide = fitDistance(cameraAt(2.4), target, boxCorners(floor))
    const narrow = fitDistance(cameraAt(0.8), target, boxCorners(floor))
    expect(narrow).toBeGreaterThan(wide)
    const camera = cameraAt(2.4)
    camera.position.normalize().multiplyScalar(wide)
    camera.lookAt(target)
    camera.updateMatrixWorld()
    const corners = [floor.min, floor.max, new THREE.Vector3(-8, 0, 5), new THREE.Vector3(8, 0, 5)]
      .map(corner => corner.clone().project(camera))
    expect(corners.every(point => Math.abs(point.x) <= 0.95 && Math.abs(point.y) <= 0.95)).toBe(true)
    // Tight: a little closer and something leaves the view.
    expect(Math.max(...corners.map(point => Math.max(Math.abs(point.x), Math.abs(point.y))))).toBeGreaterThan(0.9)
  })

  it('centres the floor on screen and comes closer than aiming at its middle', () => {
    const points = boxCorners(floor)
    const centred = fitView(cameraAt(1.5), new THREE.Vector3(), points)
    expect(centred.distance).toBeLessThan(fitDistance(cameraAt(1.5), new THREE.Vector3(), points))
    const camera = cameraAt(1.5)
    camera.position.normalize().multiplyScalar(centred.distance).add(centred.target)
    camera.lookAt(centred.target)
    camera.updateMatrixWorld()
    const heights = points.map(point => point.clone().project(camera).y)
    expect(Math.max(...heights) + Math.min(...heights)).toBeCloseTo(0, 1)
  })
})
