import * as THREE from 'three'
import { boxCorners } from './framing'
import type { officeLayout } from './layout'

// The floor's border past the outer rugs (room for the project names), and
// the height above it that heads and name bubbles reach.
const FLOOR_MARGIN = 0.9
const HEADROOM = 2.6
// Camera elevation: looking down at about 36°.
const VIEW = new THREE.Vector3(0, 0.82, 1.12).normalize()

/**
 * How the office is framed: the starting camera, the floor that hugs the
 * islands, and the points the stage keeps in view (the floor plus the people
 * and bubbles standing on each island).
 */
export function officeFrame(plan: ReturnType<typeof officeLayout>): { span: number; camera: THREE.PerspectiveCamera; ground: THREE.Box3; points: THREE.Vector3[] } {
  const span = Math.max(plan.width, plan.depth, 6)
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200)
  camera.position.copy(VIEW).multiplyScalar(span)
  const rugs = plan.islands.map(island => new THREE.Box3(new THREE.Vector3(island.x - island.width / 2, 0, island.z - island.depth / 2),
    new THREE.Vector3(island.x + island.width / 2, HEADROOM, island.z + island.depth / 2)))
  const ground = rugs.reduce((box, rug) => box.union(rug), new THREE.Box3()).expandByVector(new THREE.Vector3(FLOOR_MARGIN, 0, FLOOR_MARGIN))
  ground.min.y = -0.3
  ground.max.y = 0
  return { span, camera, ground, points: [ground, ...rugs].flatMap(boxCorners) }
}
