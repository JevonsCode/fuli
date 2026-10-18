import * as THREE from 'three'
import { createStage, cssColor, label, tokenColor, type Stage } from './stage'
import { galaxyLayout, type SceneLink, type SceneProject } from './layout'

// 3D 星系: projects are lit planets with a soft atmosphere, Agents are moons on
// tilted orbits. A moon asking you glows amber and pulses, a stuck one glows
// red, a working one wears a faint accent halo, and a finished one is dim.

const PLANET_TONES = ['--identity-0', '--identity-1', '--identity-2', '--identity-3', '--identity-4', '--identity-5']

export function mountGalaxy(container: HTMLElement, projects: readonly SceneProject[],
  { reducedMotion, onPick, links = [] }: { reducedMotion: boolean; onPick: (href: unknown) => void; links?: readonly SceneLink[] }): Stage {
  const planets = galaxyLayout(projects)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400)
  camera.position.set(0, 10, 19)
  const stage = createStage({ container, camera, reducedMotion, onPick,
    controls: { minDistance: 9, maxDistance: 34, minPolar: 0.3, maxPolar: 1.35, autoRotate: true } })
  const { scene } = stage
  const color = (name: string) => tokenColor(container, name)
  const states = { waiting: color('--status-waiting'), stuck: color('--status-error'), running: color('--color-accent'), done: color('--scene-moon-done') }
  const white = color('--scene-glow')

  scene.add(new THREE.AmbientLight(color('--scene-ambient'), 0.55))
  const sun = new THREE.DirectionalLight(color('--scene-sun'), 2.2)
  sun.position.set(-8, 10, 6)
  scene.add(sun)
  const rim = new THREE.DirectionalLight(color('--scene-rim'), 0.8)
  rim.position.set(6, -2, -8)
  scene.add(rim)
  scene.add(starfield(color('--scene-star')))

  const glow = glowTexture(white)
  const moons: { pivot: THREE.Object3D; speed: number; phase: number; halo?: THREE.Sprite; pulse: boolean }[] = []
  planets.forEach((planet, index) => {
    const system = new THREE.Group()
    system.position.set(planet.x, 0, planet.z)
    const tone = color(PLANET_TONES[index % PLANET_TONES.length]!)
    const body = new THREE.Mesh(new THREE.SphereGeometry(planet.radius, 64, 48),
      new THREE.MeshPhysicalMaterial({ color: tone, roughness: 0.55, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.4,
        sheen: 0.6, sheenColor: tone.clone().lerp(white, 0.5) }))
    system.add(body)
    system.add(atmosphere(planet.radius, tone.clone().lerp(white, 0.35)))
    const name = label(planet.project.name, 'stage-label stage-label--planet')
    name.position.set(0, -planet.radius - 0.55, 0)
    system.add(name)

    for (const orbit of planet.orbits) {
      const plane = new THREE.Group()
      plane.rotation.x = orbit.tilt
      const ring = new THREE.Mesh(new THREE.TorusGeometry(orbit.radius, 0.006, 6, 160),
        new THREE.MeshBasicMaterial({ color: color('--scene-orbit'), transparent: true, opacity: 0.16 }))
      ring.rotation.x = Math.PI / 2
      plane.add(ring)
      const pivot = new THREE.Group()
      const moonColor = cssColor(container, orbit.agent.color, '--scene-moon')
      const moon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 24),
        new THREE.MeshStandardMaterial({ color: moonColor, roughness: 0.45, emissive: states[orbit.agent.state],
          emissiveIntensity: orbit.agent.state === 'done' ? 0 : 0.35 }))
      moon.position.x = orbit.radius
      moon.userData.href = orbit.agent.href
      const tag = label(orbit.agent.name, `stage-label stage-label--moon is-${orbit.agent.state}`)
      tag.position.set(0, 0.32, 0)
      moon.add(tag)
      let halo: THREE.Sprite | undefined
      if (orbit.agent.state !== 'done') {
        halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: states[orbit.agent.state], transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false, opacity: orbit.agent.state === 'running' ? 0.45 : 0.9 }))
        halo.scale.setScalar(orbit.agent.state === 'running' ? 0.8 : 1.2)
        moon.add(halo)
      }
      pivot.add(moon)
      pivot.rotation.y = orbit.phase
      plane.add(pivot)
      system.add(plane)
      moons.push({ pivot, speed: orbit.speed, phase: orbit.phase, halo, pulse: orbit.agent.state === 'waiting' || orbit.agent.state === 'stuck' })
    }
    scene.add(system)
  })

  // Memory beams: light travels from the project that reads to the one it
  // draws from; thicker and brighter the more often it does.
  const beams = memoryBeams(planets, links, color('--color-accent').lerp(white, 0.25))
  for (const beam of beams) scene.add(beam.mesh)

  stage.onFrame(elapsed => {
    for (const beam of beams) beam.time.value = elapsed
    for (const moon of moons) {
      moon.pivot.rotation.y = moon.phase + elapsed * moon.speed
      if (moon.halo && moon.pulse) moon.halo.scale.setScalar(1.1 + Math.sin(elapsed * 3.2 + moon.phase) * 0.28)
    }
  })
  return stage
}

// A fresnel shell: bright at the limb, clear in the middle, like thin air.
function atmosphere(radius: number, glow: THREE.Color): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(radius * 1.16, 48, 32), new THREE.ShaderMaterial({
    uniforms: { glow: { value: glow } },
    vertexShader: 'varying vec3 vNormal; varying vec3 vView; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vNormal = normalize(normalMatrix * normal); vView = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 glow; varying vec3 vNormal; varying vec3 vView; void main(){ float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.6); gl_FragColor = vec4(glow, rim * 0.85); }',
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
  }))
}

function starfield(tone: THREE.Color): THREE.Points {
  const count = 900
  const positions = new Float32Array(count * 3)
  for (let index = 0; index < count; index++) {
    const radius = 60 + Math.random() * 90
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    positions.set([radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta)], index * 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: tone, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.7 }))
}

function glowTexture(tone: THREE.Color): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')!
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
  // The sprite tints it per state; only its falloff is drawn here.
  const stop = (alpha: number) => `rgb(${tone.toArray().map(channel => Math.round(channel * 255)).join(' ')} / ${alpha})`
  gradient.addColorStop(0, stop(0.9))
  gradient.addColorStop(0.35, stop(0.35))
  gradient.addColorStop(1, stop(0))
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const BEAM = { related: { radius: 0.025, speed: 0.25, strength: 0.45 }, frequent: { radius: 0.045, speed: 0.4, strength: 0.7 }, close: { radius: 0.07, speed: 0.6, strength: 1 } }

export function memoryBeams(planets: ReturnType<typeof galaxyLayout>, links: readonly SceneLink[], tone: THREE.Color) {
  const at = new Map(planets.map(planet => [planet.project.id, planet]))
  return links.flatMap(link => {
    const from = at.get(link.from)
    const to = at.get(link.to)
    if (!from || !to || from === to) return []
    const style = BEAM[link.tier]
    const start = new THREE.Vector3(from.x, 0, from.z)
    const end = new THREE.Vector3(to.x, 0, to.z)
    // Arc above the plane so beams never cut through planets.
    const middle = start.clone().lerp(end, 0.5).setY(start.distanceTo(end) * 0.28 + 0.6)
    const curve = new THREE.QuadraticBezierCurve3(start, middle, end)
    const time = { value: 0 }
    const material = new THREE.ShaderMaterial({
      uniforms: { tone: { value: tone }, time, speed: { value: style.speed }, strength: { value: style.strength } },
      vertexShader: 'varying float vAlong; void main(){ vAlong = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 tone; uniform float time; uniform float speed; uniform float strength; varying float vAlong;' +
        'void main(){ float pulse = smoothstep(0.0, 0.18, fract(vAlong - time * speed)) * (1.0 - smoothstep(0.18, 0.36, fract(vAlong - time * speed)));' +
        ' float ends = smoothstep(0.0, 0.08, vAlong) * smoothstep(1.0, 0.92, vAlong); gl_FragColor = vec4(tone, (0.3 + pulse * 0.7) * ends * strength); }',
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    return [{ mesh: new THREE.Mesh(new THREE.TubeGeometry(curve, 64, style.radius, 8, false), material), time }]
  })
}
