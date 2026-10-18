import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { memoryBeams } from './galaxy-scene'
import { galaxyLayout, type SceneProject } from './layout'

const project = (id: string): SceneProject => ({ id, name: id, agents: [] })

describe('galaxy memory beams', () => {
  it('draws one beam per link between shown projects, thicker the closer the tie', () => {
    const planets = galaxyLayout([project('a'), project('b'), project('c')])
    const beams = memoryBeams(planets, [
      { from: 'a', to: 'b', tier: 'close' },
      { from: 'b', to: 'c', tier: 'related' },
      { from: 'a', to: 'a', tier: 'close' },
      { from: 'a', to: 'hidden', tier: 'frequent' },
    ], new THREE.Color(1, 1, 1))
    expect(beams).toHaveLength(2)
    const radius = (index: number) => (beams[index]!.mesh.geometry as THREE.TubeGeometry).parameters.radius
    expect(radius(0)).toBeGreaterThan(radius(1))
  })
})
