import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { boxCorners } from './framing'
import { createStage, cssColor, label, tokenColor, type Stage } from './stage'
import { officeLayout, type SceneAgent, type SceneProject } from './layout'

// 办公室: a warm, softly lit low-poly office. Each project is an island on its
// own rug; each Agent is a small character at a desk. Working Agents type and
// their screen glows, an Agent asking you raises a "?" bubble, a stuck one
// slumps behind a red screen, and one that just finished leans back.

interface OfficePalette { accent: THREE.Color; danger: THREE.Color; skin: THREE.Color; wood: THREE.Color; woodDark: THREE.Color; chair: THREE.Color;
  monitor: THREE.Color; screen: THREE.Color; screenOff: THREE.Color; eye: THREE.Color; pot: THREE.Color; leaf: THREE.Color }
// Shoulder angle that rests the hands on the desk in front.
const ARM_DESK = -1.25

// The floor's border past the outer rugs (room for the project names), and
// the height above it that heads and name bubbles reach.
const FLOOR_MARGIN = 0.9
const HEADROOM = 2.6
// Camera elevation: looking down at about 36°.
const VIEW = new THREE.Vector3(0, 0.82, 1.12).normalize()

const RUG_TONES = ['--identity-0-soft', '--identity-1-soft', '--identity-2-soft', '--identity-3-soft', '--identity-4-soft', '--identity-5-soft']

export function mountOffice(container: HTMLElement, projects: readonly SceneProject[],
  { reducedMotion, onPick }: { reducedMotion: boolean; onPick: (href: unknown) => void }): Stage {
  const plan = officeLayout(projects)
  const span = Math.max(plan.width, plan.depth, 6)
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200)
  camera.position.copy(VIEW).multiplyScalar(span)
  // The floor hugs the islands; the stage frames it and the people and
  // bubbles standing on the islands.
  const rugs = plan.islands.map(island => new THREE.Box3(new THREE.Vector3(island.x - island.width / 2, 0, island.z - island.depth / 2),
    new THREE.Vector3(island.x + island.width / 2, HEADROOM, island.z + island.depth / 2)))
  const ground = rugs.reduce((box, rug) => box.union(rug), new THREE.Box3()).expandByVector(new THREE.Vector3(FLOOR_MARGIN, 0, FLOOR_MARGIN))
  ground.min.y = -0.3
  ground.max.y = 0
  const points = [ground, ...rugs].flatMap(boxCorners)
  const stage = createStage({ container, camera, reducedMotion, onPick,
    controls: { minDistance: span * 0.6, maxDistance: span * 1.9, minPolar: 0.35, maxPolar: 1.15 },
    frame: { points, zoomIn: 0.45, zoomOut: 1.6 } })
  const { scene } = stage

  const color = (name: string) => tokenColor(container, name)
  const palette: OfficePalette = { accent: color('--color-accent'), danger: color('--status-error'),
    skin: color('--scene-skin'), wood: color('--scene-wood'), woodDark: color('--scene-wood-dark'), chair: color('--scene-chair'),
    monitor: color('--scene-monitor'), screen: color('--scene-screen'), screenOff: color('--scene-screen-off'), eye: color('--scene-eye'),
    pot: color('--scene-pot'), leaf: color('--scene-leaf') }

  // Soft studio light: warm sky, beige bounce, one shadow-casting key light.
  scene.add(new THREE.HemisphereLight(color('--scene-sky'), color('--scene-ground'), 1.6))
  const key = new THREE.DirectionalLight(color('--scene-key'), 1.6)
  key.position.set(span * 0.35, span * 0.9, span * 0.45)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.radius = 6
  key.shadow.bias = -0.0004
  const reach = span * 0.8
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.5, far: span * 3 })
  scene.add(key)

  const groundSize = ground.getSize(new THREE.Vector3())
  const floor = new THREE.Mesh(new RoundedBoxGeometry(groundSize.x, 0.3, groundSize.z, 4, 0.4),
    new THREE.MeshStandardMaterial({ color: color('--color-surface'), roughness: 0.95 }))
  floor.position.copy(ground.getCenter(new THREE.Vector3()))
  floor.receiveShadow = true
  scene.add(floor)

  const typing: { body: THREE.Object3D; screen: THREE.MeshStandardMaterial; arms: THREE.Object3D[]; offset: number }[] = []
  const waving: { arm: THREE.Object3D; offset: number }[] = []
  plan.islands.forEach((island, index) => {
    const group = new THREE.Group()
    group.position.set(island.x, 0, island.z)
    const rug = new THREE.Mesh(new RoundedBoxGeometry(island.width, 0.04, island.depth, 3, 0.3),
      new THREE.MeshStandardMaterial({ color: color(RUG_TONES[index % RUG_TONES.length]!), roughness: 1 }))
    rug.position.y = 0.02
    rug.receiveShadow = true
    group.add(rug)
    const name = label(island.project.name, 'stage-label stage-label--project')
    name.position.set(0, 0.05, island.depth / 2 + 0.2)
    group.add(name)
    for (const desk of island.desks) {
      const station = workstation(desk.agent, cssColor(container, desk.agent.color, '--scene-agent'), palette)
      station.group.position.set(desk.x, 0, desk.z)
      group.add(station.group)
      if (desk.agent.state === 'running') typing.push({ body: station.body, screen: station.screen, arms: station.arms, offset: Math.random() * 6 })
      if (desk.agent.state === 'waiting') waving.push({ arm: station.arms[1]!, offset: Math.random() * 6 })
    }
    for (const [x, z] of [[-island.width / 2 + 0.35, -island.depth / 2 + 0.35], [island.width / 2 - 0.35, island.depth / 2 - 0.35]] as const) {
      const pot = plant(palette)
      pot.position.set(x, 0, z)
      group.add(pot)
    }
    scene.add(group)
  })

  stage.onFrame(elapsed => {
    for (const { body, screen, arms, offset } of typing) {
      body.position.y = 0.62 + Math.abs(Math.sin((elapsed + offset) * 7)) * 0.025
      screen.emissiveIntensity = 0.9 + Math.sin((elapsed + offset) * 3) * 0.15
      // Hands take turns on the keyboard.
      arms.forEach((arm, side) => { arm.rotation.x = ARM_DESK + Math.sin((elapsed + offset) * 14 + side * Math.PI) * 0.08 })
    }
    for (const { arm, offset } of waving) arm.rotation.z = -0.25 + Math.sin((elapsed + offset) * 5) * 0.35
  })
  return stage
}

function workstation(agent: SceneAgent, tone: THREE.Color, colors: OfficePalette) {
  const group = new THREE.Group()
  group.userData.href = agent.href
  const shade = (mesh: THREE.Mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; return mesh }
  const matte = (color: THREE.ColorRepresentation, roughness = 0.7) => new THREE.MeshStandardMaterial({ color, roughness })

  // Desk faces the camera; the character sits behind it, facing us.
  const top = shade(new THREE.Mesh(new RoundedBoxGeometry(1.25, 0.07, 0.68, 2, 0.03), matte(colors.wood)))
  top.position.set(0, 0.72, 0)
  group.add(top)
  for (const [x, z] of [[-0.55, -0.27], [0.55, -0.27], [-0.55, 0.27], [0.55, 0.27]] as const) {
    const leg = shade(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), matte(colors.woodDark)))
    leg.position.set(x, 0.35, z)
    group.add(leg)
  }

  // The monitor stands to the right, turned toward the character and partly toward
  // us, so its glow (accent working, red stuck, dark done) reads from the camera.
  const screenColor = agent.state === 'stuck' ? colors.danger : agent.state === 'done' ? colors.screenOff : colors.accent
  const screen = new THREE.MeshStandardMaterial({ color: colors.screen, emissive: screenColor,
    emissiveIntensity: agent.state === 'done' ? 0.05 : 0.9, roughness: 0.4 })
  const casing = matte(colors.monitor, 0.5)
  const monitor = shade(new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.4, 0.04, 2, 0.015),
    [casing, casing, casing, casing, screen, casing]))
  monitor.position.set(0.36, 1.0, 0.02)
  monitor.rotation.y = -0.9
  group.add(monitor)
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), casing)
  stand.position.set(0.36, 0.83, 0.02)
  group.add(stand)

  const body = new THREE.Group()
  body.position.set(-0.08, 0.62, -0.45)
  const torso = shade(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.28, 6, 14), matte(tone, 0.6)))
  torso.position.y = 0.18
  body.add(torso)
  const head = shade(new THREE.Mesh(new THREE.SphereGeometry(0.19, 24, 18), matte(colors.skin, 0.55)))
  head.position.y = 0.6
  body.add(head)
  const hair = shade(new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.5),
    matte(tone.clone().multiplyScalar(0.45), 0.8)))
  hair.position.y = 0.63
  hair.rotation.x = -0.25
  body.add(hair)
  for (const x of [-0.065, 0.065]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), matte(colors.eye, 0.3))
    eye.position.set(x, 0.62, 0.17)
    body.add(eye)
  }
  // Stuck slumps toward the desk; just done leans back in the chair.
  // Arms hang from the shoulders: on the desk while working or stuck, at the
  // sides when done, and the right one raised while asking you.
  const arms = [-1, 1].map(side => {
    const shoulder = new THREE.Group()
    shoulder.position.set(side * 0.22, 0.36, 0)
    // Sleeves a shade darker than the body so the pose reads at a distance.
    const arm = shade(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.22, 4, 10), matte(tone.clone().multiplyScalar(0.72), 0.6)))
    arm.position.y = -0.14
    shoulder.add(arm)
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), matte(colors.skin, 0.55))
    hand.position.y = -0.29
    shoulder.add(hand)
    shoulder.rotation.x = agent.state === 'done' ? -0.15 : ARM_DESK
    body.add(shoulder)
    return shoulder
  })
  if (agent.state === 'waiting') { arms[1]!.rotation.x = Math.PI; arms[1]!.rotation.z = -0.25 }
  if (agent.state === 'stuck') body.rotation.x = 0.3
  if (agent.state === 'done') body.rotation.x = -0.24
  group.add(body)
  const seat = shade(new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.08, 0.46, 2, 0.03), matte(colors.chair)))
  seat.position.set(-0.08, 0.46, -0.5)
  group.add(seat)
  const back = shade(new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.55, 0.06, 2, 0.03), matte(colors.chair)))
  back.position.set(-0.08, 0.76, -0.76)
  group.add(back)

  const bubble = { waiting: '?', stuck: '!', done: '✓', running: '' }[agent.state]
  if (bubble) {
    const sign = label(bubble, `stage-bubble stage-bubble--${agent.state}`)
    sign.position.set(-0.08, 2.25, -0.45)
    group.add(sign)
  }
  const name = label(agent.name, `stage-label stage-label--agent is-${agent.state}`)
  name.position.set(-0.08, 1.8, -0.45)
  group.add(name)
  return { group, body, screen, arms }
}

// A small potted plant: terracotta pot and two leafy spheres.
function plant(colors: OfficePalette): THREE.Group {
  const group = new THREE.Group()
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.3, 20), new THREE.MeshStandardMaterial({ color: colors.pot, roughness: 0.8 }))
  pot.position.y = 0.15
  pot.castShadow = true
  group.add(pot)
  for (const [x, y, r] of [[0, 0.5, 0.22], [0.1, 0.68, 0.15]] as const) {
    const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshStandardMaterial({ color: colors.leaf, roughness: 0.75, flatShading: true }))
    leaf.position.set(x, y, 0)
    leaf.castShadow = true
    group.add(leaf)
  }
  return group
}
