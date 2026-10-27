<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import type { WorkbenchBoard } from './workbench-board'
import { starProjects, type StarAgent, type StarState } from './workbench-model'

// 星图: each project with work is a planet and its Agents circle it. Who is
// waiting on you blinks, who is working pulses, who is stuck wears a red ring.
const props = defineProps<{ board: WorkbenchBoard }>()
const MAX_PLANETS = 7
const MAX_MOONS = 8
const WIDTH = 960
const ROW = 250
const STATES: readonly StarState[] = ['waiting', 'stuck', 'running', 'done']

const projects = computed(() => starProjects(props.board.tasks, props.board.attention).slice(0, MAX_PLANETS))
// Planets sit on an even grid, busiest first, up to four a row; every other
// column drops a little so the map reads as a sky rather than a table.
const columns = computed(() => Math.min(4, Math.max(1, Math.ceil(projects.value.length / Math.ceil(projects.value.length / 4)))))
const height = computed(() => ROW * Math.max(1, Math.ceil(projects.value.length / columns.value)))
const planets = computed(() => projects.value.map((project, index) => {
  const column = index % columns.value
  const x = (WIDTH / columns.value) * (column + 0.5)
  const y = ROW * (Math.floor(index / columns.value) + 0.5) + (column % 2 ? 22 : -14)
  const radius = 20 + 4 * Math.min(project.agents.length, 5)
  const orbit = radius + 26
  const moons = project.agents.slice(0, MAX_MOONS).map((agent, moon, list) => {
    const theta = (2 * Math.PI * moon) / list.length - Math.PI / 2
    return { agent, x: x + orbit * Math.cos(theta), y: y + orbit * Math.sin(theta) }
  })
  return { project, x, y, radius, orbit, moons, hidden: project.agents.length - moons.length }
}))
const counts = computed(() => Object.fromEntries(STATES.map(state => [state,
  projects.value.reduce((sum, project) => sum + project.agents.filter(agent => agent.state === state).length, 0)])) as Record<StarState, number>)

const face = (agent: StarAgent) => props.board.agentFace(agent.agentId)
const initial = (agent: StarAgent) => face(agent).name.trim().slice(0, 1).toUpperCase()
const target = (agent: StarAgent) => agent.question ? props.board.questionHref(agent.question) : agent.task ? props.board.taskHref(agent.task) : null
const label = (agent: StarAgent) => `${face(agent).name} · ${t(`workbench.projection.${agent.state}`)}`
  + (agent.question ? ` · ${agent.question.title}` : agent.task ? ` · ${agent.task.title}` : '')
const shortName = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name)
</script>

<template>
  <div class="constellation" data-workbench="constellation">
    <p v-if="!planets.length" class="constellation-empty">{{ t('workbench.constellation.empty') }}</p>
    <svg v-else class="constellation-map" :viewBox="`0 0 ${WIDTH} ${height}`" role="img" :aria-label="t('workbench.constellation.aria', { count: planets.length })">
      <defs>
        <radialGradient id="constellation-planet" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stop-color="var(--color-accent-soft)" />
          <stop offset="100%" stop-color="var(--color-surface)" />
        </radialGradient>
      </defs>
      <g v-for="planet in planets" :key="planet.project.projectId" class="constellation-system" data-planet>
        <circle class="constellation-orbit" :cx="planet.x" :cy="planet.y" :r="planet.orbit" />
        <circle class="constellation-planet" :class="{ 'is-busy': planet.project.busy }" :cx="planet.x" :cy="planet.y" :r="planet.radius" />
        <text class="constellation-planet-name" :x="planet.x" :y="planet.y + planet.orbit + 26">{{ shortName(board.projectName(planet.project.projectId)) }}</text>
        <text v-if="planet.hidden" class="constellation-more" :x="planet.x" :y="planet.y + 4">+{{ planet.hidden }}</text>
        <template v-for="moon in planet.moons" :key="moon.agent.agentId">
          <RouterLink v-if="target(moon.agent)" v-slot="{ href, navigate }" :to="target(moon.agent)!" custom>
            <a :href="href" class="constellation-moon" :class="`is-${moon.agent.state}`" :aria-label="label(moon.agent)" data-moon @click="navigate">
              <title>{{ label(moon.agent) }}</title>
              <circle class="constellation-halo" :cx="moon.x" :cy="moon.y" r="17" />
              <circle class="constellation-moon-body" :cx="moon.x" :cy="moon.y" r="13"
                :style="{ fill: face(moon.agent).softColor ?? undefined, stroke: face(moon.agent).color ?? undefined }" />
              <image v-if="face(moon.agent).image" :href="face(moon.agent).image!" :x="moon.x - 13" :y="moon.y - 13" width="26" height="26" class="constellation-moon-image" />
              <text v-else class="constellation-moon-initial" :x="moon.x" :y="moon.y + 4" :style="{ fill: face(moon.agent).color ?? undefined }">{{ initial(moon.agent) }}</text>
            </a>
          </RouterLink>
        </template>
      </g>
    </svg>
    <p class="constellation-count-label">{{ t('workbench.scene.memberCounts') }}</p>
    <ul class="constellation-legend">
      <li v-for="state in STATES" :key="state" :class="`is-${state}`"><i aria-hidden="true" />{{ t(`workbench.projection.${state}`) }} <span>{{ counts[state] }}</span></li>
    </ul>
  </div>
</template>

<style scoped>
.constellation-count-label { margin: 0; color: var(--color-muted); font-size: 12px; }
.constellation { display: grid; gap: 12px; }
.constellation-map { width: 100%; height: auto; max-height: 560px; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: radial-gradient(ellipse at 50% 45%, var(--color-surface), var(--color-surface-subtle)); }
.constellation-orbit { fill: none; stroke: var(--color-border); stroke-dasharray: 3 6; }
.constellation-planet { fill: url(#constellation-planet); stroke: var(--color-border-strong, var(--color-border)); stroke-width: 1.5; }
.constellation-planet.is-busy { stroke: var(--color-accent); filter: drop-shadow(0 0 10px var(--color-accent-soft)); }
.constellation-planet-name { fill: var(--color-ink); font-size: 13px; font-weight: 600; text-anchor: middle; }
.constellation-more { fill: var(--color-muted); font-size: 12px; text-anchor: middle; }
.constellation-moon { cursor: pointer; }
.constellation-moon-body { fill: var(--color-accent-soft); stroke: var(--color-accent); stroke-width: 1.5; }
.constellation-moon-image { clip-path: circle(50%); pointer-events: none; }
.constellation-moon-initial { fill: var(--color-accent); font-size: 11px; font-weight: 650; text-anchor: middle; pointer-events: none; }
.constellation-halo { fill: none; stroke: transparent; stroke-width: 2; transform-box: fill-box; transform-origin: center; }
.constellation-moon.is-running .constellation-halo { stroke: var(--status-working, var(--color-accent)); animation: constellation-pulse 2.4s ease-in-out infinite; }
.constellation-moon.is-waiting .constellation-halo { stroke: var(--status-waiting, var(--color-warning)); stroke-width: 3; animation: constellation-blink 1.2s ease-in-out infinite; }
.constellation-moon.is-stuck .constellation-halo { stroke: var(--status-error, var(--color-danger)); stroke-width: 3; }
.constellation-moon.is-done { opacity: .55; }
.constellation-moon:hover .constellation-moon-body, .constellation-moon:focus-visible .constellation-moon-body { stroke-width: 3; }
@keyframes constellation-pulse { 0%, 100% { opacity: .35; transform: scale(.95); } 50% { opacity: .9; transform: scale(1.12); } }
@keyframes constellation-blink { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
.constellation-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; padding: 0; list-style: none; color: var(--color-muted); font-size: 12px; }
.constellation-legend li { display: inline-flex; align-items: center; gap: 6px; }
.constellation-legend i { width: 8px; height: 8px; border-radius: 50%; background: var(--color-faint); }
.constellation-legend .is-waiting i { background: var(--status-waiting, var(--color-warning)); }
.constellation-legend .is-stuck i { background: var(--status-error, var(--color-danger)); }
.constellation-legend .is-running i { background: var(--status-working, var(--color-accent)); }
.constellation-legend span { color: var(--color-ink); font-variant-numeric: tabular-nums; }
.constellation-empty { margin: 0; padding: 56px 24px; border: 1px dashed var(--color-border); border-radius: var(--radius-card); color: var(--color-muted); text-align: center; }
@media (prefers-reduced-motion: reduce) { .constellation-halo { animation: none !important; } }
:root[data-motion="reduced"] .constellation-halo { animation: none !important; }
</style>
