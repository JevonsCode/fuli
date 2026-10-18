import { describe, expect, it } from 'vitest'
import { galaxyLayout, MAX_SCENE_AGENTS, MAX_SCENE_PROJECTS, officeLayout, type SceneProject } from './layout'

const project = (id: string, agents: number): SceneProject => ({
  id, name: id,
  agents: Array.from({ length: agents }, (_, index) => ({ id: `${id}-${index}`, name: `A${index}`, state: 'running' as const, color: null, href: `/t/${id}-${index}` })),
})

describe('3D workbench layout', () => {
  it('seats every Agent at its own desk, four a row, islands apart on a grid', () => {
    const plan = officeLayout([project('a', 5), project('b', 2), project('c', 1)])
    expect(plan.islands.map(island => island.desks.length)).toEqual([5, 2, 1])
    const [first] = plan.islands
    // Five desks make two rows: four, then one centred.
    expect(new Set(first!.desks.map(desk => desk.z)).size).toBe(2)
    expect(first!.desks[4]!.x).toBe(0)
    const centres = plan.islands.map(island => `${island.x},${island.z}`)
    expect(new Set(centres).size).toBe(3)
  })

  it('caps what one scene draws', () => {
    const many = Array.from({ length: MAX_SCENE_PROJECTS + 2 }, (_, index) => project(`p${index}`, MAX_SCENE_AGENTS + 3))
    expect(officeLayout(many).islands).toHaveLength(MAX_SCENE_PROJECTS)
    expect(officeLayout(many).islands[0]!.desks).toHaveLength(MAX_SCENE_AGENTS)
    expect(galaxyLayout(many)).toHaveLength(MAX_SCENE_PROJECTS)
  })

  it('gives each moon its own orbit outside its planet, slower when it needs you', () => {
    const [planet] = galaxyLayout([{ ...project('a', 3), agents: [
      ...project('a', 2).agents, { id: 'q', name: 'Q', state: 'waiting', color: null, href: '/inbox/q' },
    ] }])
    const radii = planet!.orbits.map(orbit => orbit.radius)
    expect(new Set(radii).size).toBe(radii.length)
    expect(Math.min(...radii)).toBeGreaterThan(planet!.radius)
    const waiting = planet!.orbits.find(orbit => orbit.agent.state === 'waiting')!
    expect(waiting.speed).toBeLessThan(planet!.orbits[0]!.speed)
  })
})
