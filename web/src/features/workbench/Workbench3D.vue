<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { motionReduced } from '@/lib/motion-preference'
import ConstellationBoard from './ConstellationBoard.vue'
import type { WorkbenchBoard } from './workbench-board'
import { starProjects, type StarState } from './workbench-model'
import { getJson } from '@/api/client'
import type { SceneLink, SceneProject } from './three/layout'
import type { Stage } from './three/stage'

// The 3D workbench designs. three.js loads only when one is shown; without
// WebGL the 2D star map stands in, and reduced motion renders a still frame.
const props = defineProps<{ board: WorkbenchBoard; scene: 'office' | 'galaxy' }>()
const router = useRouter()
const host = ref<HTMLElement | null>(null)
const loading = ref(true)
const fallback = ref(false)
let stage: Stage | null = null
// Each mount bumps this; a slower earlier mount drops its result instead of
// leaving a second scene (and its labels) behind.
let version = 0

const STATES: readonly StarState[] = ['waiting', 'stuck', 'running', 'done']
const projects = computed<SceneProject[]>(() => starProjects(props.board.tasks, props.board.attention).map(project => ({
  id: project.projectId,
  name: props.board.projectName(project.projectId),
  agents: project.agents.map(agent => ({
    id: agent.agentId,
    name: props.board.agentFace(agent.agentId).name,
    state: agent.state,
    color: props.board.agentFace(agent.agentId).color,
    href: agent.question ? props.board.questionHref(agent.question) : agent.task ? props.board.taskHref(agent.task) : null,
  })),
})))
const counts = computed(() => Object.fromEntries(STATES.map(state => [state,
  projects.value.reduce((sum, project) => sum + project.agents.filter(agent => agent.state === state).length, 0)])) as Record<StarState, number>)

async function mount() {
  const current = ++version
  stage?.dispose()
  stage = null
  if (!host.value || !projects.value.length) { loading.value = false; return }
  loading.value = true
  try {
    const { webglAvailable } = await import('./three/stage')
    if (!webglAvailable()) { fallback.value = true; return }
    const module = props.scene === 'office' ? await import('./three/office-scene') : await import('./three/galaxy-scene')
    if (!host.value || current !== version) return
    const mountScene = 'mountOffice' in module ? module.mountOffice : module.mountGalaxy
    const links = props.scene === 'galaxy' ? await relationLinks() : []
    if (!host.value || current !== version) return
    stage = mountScene(host.value, projects.value, {
      links,
      reducedMotion: motionReduced(),
      onPick: href => { if (href) void router.push(href as RouteLocationRaw) },
    })
  } catch {
    fallback.value = true
  } finally {
    if (current === version) loading.value = false
  }
}

// Memory beams are optional: an install without the weights endpoint shows none.
async function relationLinks(): Promise<SceneLink[]> {
  if (!props.board.personalSpaceId) return []
  try {
    const result = await getJson<{ links?: { fromProjectId: string; toProjectId: string; tier: SceneLink['tier'] }[] }>(
      `/api/projects/relation-weights?personalSpaceId=${encodeURIComponent(props.board.personalSpaceId)}`)
    return (result.links ?? []).map(link => ({ from: link.fromProjectId, to: link.toProjectId, tier: link.tier }))
  } catch {
    return []
  }
}

onMounted(mount)
// Rebuild only when who works where, their names or their state change.
// Names arrive after the first paint, so they are part of the key.
watch(() => JSON.stringify(projects.value.map(project => [project.id, project.name, project.agents.map(agent => [agent.id, agent.name, agent.state])])), mount)
watch(() => props.scene, mount)
onBeforeUnmount(() => stage?.dispose())
</script>

<template>
  <ConstellationBoard v-if="fallback" :board="board" />
  <div v-else class="workbench-3d" :class="`is-${scene}`" :data-workbench="scene">
    <p v-if="!loading && !projects.length" class="workbench-3d-empty">{{ t('workbench.constellation.empty') }}</p>
    <div v-show="projects.length" ref="host" class="workbench-3d-stage" role="img"
      :aria-label="t(`workbench.scene.${scene}.aria`, { count: projects.length })">
      <GrowthLoading v-if="loading" variant="compact" :label="t('workbench.scene.loading')" />
    </div>
    <ul class="workbench-3d-legend">
      <li v-for="state in STATES" :key="state" :class="`is-${state}`"><i aria-hidden="true" />{{ t(`workbench.lanes.${state}`) }} <span>{{ counts[state] }}</span></li>
      <li class="workbench-3d-hint">{{ t('workbench.scene.hint') }}</li>
    </ul>
  </div>
</template>

<style scoped>
.workbench-3d { display: grid; gap: 12px; }
.workbench-3d-stage { position: relative; height: clamp(420px, 62vh, 640px); overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: radial-gradient(ellipse at 50% 30%, var(--color-surface), var(--color-surface-subtle)); }
.is-galaxy .workbench-3d-stage { border-color: transparent; background: radial-gradient(ellipse at 40% 30%, var(--scene-space), var(--scene-space-deep) 70%); }
.workbench-3d-stage :deep(canvas) { display: block; }
.workbench-3d-stage :deep(.stage-labels) { position: absolute; inset: 0; cursor: grab; }
.workbench-3d-stage :deep(.stage-labels:active) { cursor: grabbing; }
.workbench-3d-stage :deep(.stage-label) { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; pointer-events: none;
  color: var(--color-ink); background: color-mix(in srgb, var(--color-surface) 88%, transparent); box-shadow: var(--shadow-xs); }
.workbench-3d-stage :deep(.stage-label--project), .workbench-3d-stage :deep(.stage-label--planet) { font-size: 13px; padding: 3px 10px; }
.workbench-3d-stage :deep(.stage-label.is-done) { opacity: .6; }
.is-galaxy .workbench-3d-stage :deep(.stage-label) { color: var(--scene-space-ink); background: var(--scene-space-label); box-shadow: none; }
.is-galaxy .workbench-3d-stage :deep(.stage-label--moon) { font-size: 11px; font-weight: 500; }
.workbench-3d-stage :deep(.stage-bubble) { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50% 50% 50% 4px; font-size: 14px; font-weight: 800;
  color: var(--color-on-accent); pointer-events: none; box-shadow: var(--shadow-sm); }
.workbench-3d-stage :deep(.stage-bubble--waiting) { background: var(--status-waiting, var(--color-warning)); animation: stage-bob 1.4s ease-in-out infinite; }
.workbench-3d-stage :deep(.stage-bubble--stuck) { background: var(--status-error, var(--color-danger)); }
.workbench-3d-stage :deep(.stage-bubble--done) { background: var(--color-success); opacity: .85; }
/* `translate`, not `transform`: CSS2D positions labels with transform. */
@keyframes stage-bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -5px; } }
.workbench-3d-stage > :deep(.growth-loading) { position: absolute; inset: 0; margin: auto; height: fit-content; }
.workbench-3d-empty { margin: 0; padding: 56px 24px; border: 1px dashed var(--color-border); border-radius: var(--radius-card); color: var(--color-muted); text-align: center; }
.workbench-3d-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; padding: 0; list-style: none; color: var(--color-muted); font-size: 12px; }
.workbench-3d-legend li { display: inline-flex; align-items: center; gap: 6px; }
.workbench-3d-legend i { width: 8px; height: 8px; border-radius: 50%; background: var(--color-faint); }
.workbench-3d-legend .is-waiting i { background: var(--status-waiting, var(--color-warning)); }
.workbench-3d-legend .is-stuck i { background: var(--status-error, var(--color-danger)); }
.workbench-3d-legend .is-running i { background: var(--status-working, var(--color-accent)); }
.workbench-3d-legend span { color: var(--color-ink); font-variant-numeric: tabular-nums; }
.workbench-3d-legend .workbench-3d-hint { margin-left: auto; color: var(--color-faint); }
@media (prefers-reduced-motion: reduce) { .workbench-3d-stage :deep(.stage-bubble) { animation: none; } }
:root[data-motion="reduced"] .workbench-3d-stage :deep(.stage-bubble) { animation: none; }
</style>
