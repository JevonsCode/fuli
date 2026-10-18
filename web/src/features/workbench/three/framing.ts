import * as THREE from 'three'

// How many times the search may double the distance before it gives up; from
// a start at four times the points' reach this covers any finite stage.
const MAX_GROWTH = 24
// Bisection steps once a fitting distance is bracketed.
const REFINE_STEPS = 32

/** The eight corners of a box, for framing. */
export function boxCorners({ min, max }: THREE.Box3): THREE.Vector3[] {
  return [min.x, max.x].flatMap(x => [min.y, max.y].flatMap(y => [min.z, max.z].map(z => new THREE.Vector3(x, y, z))))
}

/**
 * The closest camera distance, along the camera's current direction from
 * `target`, at which every point lands inside the view with a `margin`
 * (fraction of the half-view kept clear), or null when none is found.
 * Projecting the points accounts for perspective: the near edge of a floor
 * looks larger than the far one, which a symmetric field-of-view formula
 * misses. The far plane is ignored: the caller moves it out to the distance.
 */
export function fitDistance(camera: THREE.PerspectiveCamera, target: THREE.Vector3, corners: readonly THREE.Vector3[], margin = 0.06): number | null {
  const probe = camera.clone()
  const direction = camera.position.clone().sub(target).normalize()
  const limit = 1 - margin
  const fits = (distance: number) => {
    probe.position.copy(target).addScaledVector(direction, distance)
    probe.lookAt(target)
    probe.updateMatrixWorld()
    probe.updateProjectionMatrix()
    return corners.every(corner => {
      const inFront = -corner.clone().applyMatrix4(probe.matrixWorldInverse).z > probe.near
      const point = corner.clone().project(probe)
      return inFront && Math.abs(point.x) <= limit && Math.abs(point.y) <= limit
    })
  }
  let near = 0
  let far = Math.max(...corners.map(corner => corner.distanceTo(target) * 4), 1)
  for (let growth = 0; !fits(far); growth += 1) {
    if (growth >= MAX_GROWTH) return null
    far *= 2
  }
  for (let step = 0; step < REFINE_STEPS; step += 1) {
    const middle = (near + far) / 2
    if (fits(middle)) far = middle
    else near = middle
  }
  return far
}

/**
 * Frame the points: re-aim the target so they sit centred on screen (the near
 * side of a floor otherwise crowds the bottom edge), then fit the distance.
 * `reach` is how far the farthest point lies from the target, so the caller
 * can keep the far plane past `distance + reach`. Null when no fit is found;
 * the caller keeps its current framing.
 */
export function fitView(camera: THREE.PerspectiveCamera, target: THREE.Vector3, points: readonly THREE.Vector3[]): { target: THREE.Vector3; distance: number; reach: number } | null {
  const probe = camera.clone()
  const direction = camera.position.clone().sub(target).normalize()
  const aim = target.clone()
  let distance = fitDistance(camera, aim, points)
  for (let pass = 0; pass < 3 && distance !== null; pass += 1) {
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
  if (distance === null) return null
  return { target: aim, distance, reach: Math.max(...points.map(point => point.distanceTo(aim))) }
}
