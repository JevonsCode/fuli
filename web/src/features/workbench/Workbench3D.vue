<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { motionReduced } from '@/lib/motion-preference'
import type { WorkbenchBoard } from './workbench-board'
import { starProjects, type StarState } from './workbench-model'
import { getJson } from '@/api/client'
import type { SceneLink, SceneProject } from './three/layout'
import type { Stage } from './three/stage'
const props = defineProps<{ board: WorkbenchBoard; scene: 'office' | 'galaxy' }>()
const emit = defineEmits<{ fallback: []; pick: [href: unknown] }>()
const host = ref<HTMLElement | null>(null)
const loading = ref(true), slow = ref(false), fallback = ref(false)
let stage: Stage | null = null, version = 0
let controller: AbortController | undefined
let slowTimer: ReturnType<typeof setTimeout> | undefined, endTimer: ReturnType<typeof setTimeout> | undefined
const STATES: readonly StarState[] = ['waiting', 'stuck', 'running', 'done']
const projects = computed<SceneProject[]>(() => starProjects(props.board.tasks, props.board.attention).map(project => ({
  id: project.projectId, name: props.board.projectName(project.projectId),
  agents: project.agents.map(agent => ({ id: agent.agentId, name: props.board.agentFace(agent.agentId).name, state: agent.state,
    color: props.board.agentFace(agent.agentId).color, href: agent.question ? props.board.questionHref(agent.question) : agent.task ? props.board.taskHref(agent.task) : null })),
})))
const counts = computed(() => Object.fromEntries(STATES.map(state => [state, projects.value.reduce((sum, project) => sum + project.agents.filter(agent => agent.state === state).length, 0)])) as Record<StarState, number>)
function stop() { version++; controller?.abort(); clearTimeout(slowTimer); clearTimeout(endTimer); stage?.dispose(); stage = null }
function fail() { stop(); loading.value = false; fallback.value = true; emit('fallback') }
function contextLost(event: Event) { event.preventDefault(); fail() }
async function mount() {
  stop()
  const current = version
  if (!host.value || !projects.value.length) { loading.value = false; return }
  loading.value = true; slow.value = false; fallback.value = false
  controller = new AbortController()
  slowTimer = setTimeout(() => { if (current === version) slow.value = true }, 8000)
  endTimer = setTimeout(() => { if (current === version) fail() }, 30000)
  try {
    const { webglAvailable } = await import('./three/stage')
    if (current !== version || !host.value) return
    if (!webglAvailable()) { fail(); return }
    const module = props.scene === 'office' ? await import('./three/office-scene') : await import('./three/galaxy-scene')
    if (current !== version || !host.value) return
    const mountScene = 'mountOffice' in module ? module.mountOffice : module.mountGalaxy
    const links = props.scene === 'galaxy' ? await relationLinks(controller.signal) : []
    if (current !== version || !host.value) return
    stage = mountScene(host.value, projects.value, { links, reducedMotion: motionReduced(), onPick: href => emit('pick', href) })
  } catch { if (current === version) fail() }
  finally { if (current === version) { loading.value = false; clearTimeout(slowTimer); clearTimeout(endTimer) } }
}
async function relationLinks(signal: AbortSignal): Promise<SceneLink[]> {
  if (!props.board.personalSpaceId) return []
  try {
    type Weight = { fromProjectId: string; toProjectId: string; tier: SceneLink['tier'] }
    const result = await getJson<Weight[] | { links?: Weight[] }>(`/api/projects/relation-weights?personalSpaceId=${encodeURIComponent(props.board.personalSpaceId)}`, { signal })
    return (Array.isArray(result) ? result : result.links ?? []).map(link => ({ from: link.fromProjectId, to: link.toProjectId, tier: link.tier }))
  } catch { return [] }
}
onMounted(() => { host.value?.addEventListener('webglcontextlost', contextLost, true); void mount() })
watch(() => JSON.stringify([props.board.personalSpaceId, projects.value]), mount)
watch(() => props.scene, mount)
onBeforeUnmount(() => { host.value?.removeEventListener('webglcontextlost', contextLost, true); stop() })
</script>
<template>
  <div v-if="fallback" role="status">{{ t('overview.views.fallback') }}</div>
  <div v-else class="workbench-3d" :class="`is-${scene}`" :data-workbench="scene">
    <div v-show="projects.length" ref="host" class="workbench-3d-stage" role="img" :aria-label="t(`workbench.scene.${scene}.aria`, { count: projects.length })">
      <GrowthLoading v-if="loading" variant="compact" :label="t('workbench.scene.loading')" />
    </div>
    <p v-if="slow && loading" role="status">{{ t('overview.read.slow') }}</p>
    <p class="workbench-3d-count-label">{{ t('workbench.scene.memberCounts') }}</p>
    <ul class="workbench-3d-legend">
      <li v-for="state in STATES" :key="state" :class="`is-${state}`"><i aria-hidden="true" />{{ t(`workbench.projection.${state}`) }} <span>{{ counts[state] }}</span></li>
      <li class="workbench-3d-hint">{{ t('workbench.scene.hint') }}</li>
    </ul>
  </div>
</template>

<style scoped>
.workbench-3d { display: grid; gap: 12px; }
.workbench-3d-stage { position: relative; height: clamp(420px, 62vh, 640px); overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: radial-gradient(ellipse at 50% 30%, var(--color-surface), var(--color-surface-subtle)); }
.is-galaxy .workbench-3d-stage { border-color: transparent; background: radial-gradient(ellipse at 40% 30%, var(--scene-space), var(--scene-space-deep) 70%); }
.workbench-3d-stage :deep(.stage-label--agent) { display: none; }
.workbench-3d-count-label { margin: 0; color: var(--color-muted); font-size: 12px; }
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
.workbench-3d-legend .workbench-3d-hint { margin-left: auto; color: var(--color-muted); }
@media (prefers-reduced-motion: reduce) { .workbench-3d-stage :deep(.stage-bubble) { animation: none; } }
:root[data-motion="reduced"] .workbench-3d-stage :deep(.stage-bubble) { animation: none; }
</style>
