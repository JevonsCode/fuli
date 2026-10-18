import * as THREE from 'three'

/** The eight corners of a box, for framing. */
export function boxCorners({ min, max }: THREE.Box3): THREE.Vector3[] {
  return [min.x, max.x].flatMap(x => [min.y, max.y].flatMap(y => [min.z, max.z].map(z => new THREE.Vector3(x, y, z))))
}

/**
 * The closest camera distance, along the camera's current direction from
 * `target`, at which every point lands inside the view with a `margin`
 * (fraction of the half-view kept clear). Projecting the points accounts for
 * perspective: the near edge of a floor looks larger than the far one, which
 * a symmetric field-of-view formula misses.
 */
export function fitDistance(camera: THREE.PerspectiveCamera, target: THREE.Vector3, corners: readonly THREE.Vector3[], margin = 0.06): number {
  const probe = camera.clone()
  const direction = camera.position.clone().sub(target).normalize()
  const limit = 1 - margin
  const fits = (distance: number) => {
    probe.position.copy(target).addScaledVector(direction, distance)
    probe.lookAt(target)
    probe.updateMatrixWorld()
    probe.updateProjectionMatrix()
    return corners.every(corner => {
      const point = corner.clone().project(probe)
      return Math.abs(point.x) <= limit && Math.abs(point.y) <= limit && point.z < 1
    })
  }
  let near = 0
  let far = Math.max(...corners.map(corner => corner.distanceTo(target) * 4), 1)
  while (!fits(far)) far *= 2
  for (let step = 0; step < 32; step += 1) {
    const middle = (near + far) / 2
    if (fits(middle)) far = middle
    else near = middle
  }
  return far
}

/**
 * Frame the points: re-aim the target so they sit centred on screen (the near
 * side of a floor otherwise crowds the bottom edge), then fit the distance.
 */
export function fitView(camera: THREE.PerspectiveCamera, target: THREE.Vector3, points: readonly THREE.Vector3[]): { target: THREE.Vector3; distance: number } {
  const probe = camera.clone()
  const direction = camera.position.clone().sub(target).normalize()
  const aim = target.clone()
  let distance = fitDistance(camera, aim, points)
  for (let pass = 0; pass < 3; pass += 1) {
    probe.position.copy(aim).addScaledVector(direction, distance)
    probe.lookAt(aim)
    probe.updateMatrixWorld()
    const heights = points.map(point => point.clone().project(probe).y)
    const offset = (Math.max(...heights) + Math.min(...heights)) / 2
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(probe.quaternion)
    aim.addScaledVector(up, offset * Math.tan((probe.fov * Math.PI) / 360) * distance)
    probe.position.copy(aim).addScaledVector(direction, distance)
    distance = fitDistance(probe, aim, points)
  }
  return { target: aim, distance }
}
