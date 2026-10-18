import type { StarState } from '../workbench-model'

// What a 3D scene draws: plain data, so layout is testable without WebGL.
export interface SceneAgent { id: string; name: string; state: StarState; color: string | null; href: unknown }
export interface SceneProject { id: string; name: string; agents: SceneAgent[] }

export const MAX_SCENE_PROJECTS = 6
export const MAX_SCENE_AGENTS = 8

export interface DeskSpot { agent: SceneAgent; x: number; z: number }
export interface Island { project: SceneProject; x: number; z: number; width: number; depth: number; desks: DeskSpot[] }

const DESK_GAP_X = 1.7
const DESK_GAP_Z = 1.9
const PER_ROW = 4

/**
 * Office floor plan: each project is an island of desks, up to four desks a
 * row, every desk facing the camera. Islands sit on a grid, busiest first.
 */
export function officeLayout(projects: readonly SceneProject[]): { islands: Island[]; width: number; depth: number } {
  const shown = projects.slice(0, MAX_SCENE_PROJECTS)
  const islands = shown.map(project => {
    const agents = project.agents.slice(0, MAX_SCENE_AGENTS)
    const columns = Math.min(PER_ROW, Math.max(agents.length, 1))
    const rows = Math.max(1, Math.ceil(agents.length / PER_ROW))
    const width = columns * DESK_GAP_X + 0.9
    const depth = rows * DESK_GAP_Z + 1.4
    const desks = agents.map((agent, index) => {
      const column = index % PER_ROW
      const row = Math.floor(index / PER_ROW)
      const inRow = Math.min(PER_ROW, agents.length - row * PER_ROW)
      return { agent, x: (column - (inRow - 1) / 2) * DESK_GAP_X, z: (row - (rows - 1) / 2) * DESK_GAP_Z }
    })
    return { project, x: 0, z: 0, width, depth, desks }
  })
  const columns = islands.length <= 2 ? islands.length : islands.length <= 4 ? 2 : 3
  const cellWidth = Math.max(...islands.map(island => island.width), 1) + 1
  // Rows need room for the next row's name bubbles above the heads.
  const cellDepth = Math.max(...islands.map(island => island.depth), 1) + 3.2
  const rows = Math.max(1, Math.ceil(islands.length / Math.max(columns, 1)))
  islands.forEach((island, index) => {
    const column = index % Math.max(columns, 1)
    const row = Math.floor(index / Math.max(columns, 1))
    island.x = (column - (Math.max(columns, 1) - 1) / 2) * cellWidth
    island.z = (row - (rows - 1) / 2) * cellDepth
  })
  return { islands, width: Math.max(columns, 1) * cellWidth, depth: rows * cellDepth }
}

/** How much one project draws memory from another (project memory usage tiers). */
export interface SceneLink { from: string; to: string; tier: 'related' | 'frequent' | 'close' }

export interface Orbit { agent: SceneAgent; radius: number; phase: number; speed: number; tilt: number }
export interface Planet { project: SceneProject; x: number; z: number; radius: number; orbits: Orbit[] }

/** Galaxy plan: planets on a wide ellipse, each Agent a moon on its own tilted orbit. */
export function galaxyLayout(projects: readonly SceneProject[]): Planet[] {
  const shown = projects.slice(0, MAX_SCENE_PROJECTS)
  return shown.map((project, index) => {
    const angle = shown.length === 1 ? 0 : (2 * Math.PI * index) / shown.length
    const spread = shown.length === 1 ? 0 : 7.6
    const radius = 0.72 + Math.min(project.agents.length, 6) * 0.07
    const orbits = project.agents.slice(0, MAX_SCENE_AGENTS).map((agent, moon, list) => ({
      agent,
      radius: radius + 0.6 + moon * 0.28,
      phase: (2 * Math.PI * moon) / list.length,
      // Urgent moons move slower so they are easy to catch and click.
      speed: agent.state === 'waiting' || agent.state === 'stuck' ? 0.12 : 0.28 - moon * 0.015,
      tilt: ((moon % 3) - 1) * 0.28,
    }))
    return { project, x: Math.cos(angle) * spread, z: Math.sin(angle) * spread * 0.62, radius, orbits }
  })
}
