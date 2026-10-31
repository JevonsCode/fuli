<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { agentDisplayName, agentProfilePath } from '@/features/agent-profile/profile-model'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import { agentManagementPath } from '@/features/project-agents/orchestration-filters'
import { statusTone } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { UiNotice } from '@/ui'
import { readTaskSheets, shareFill, sharesFor, type TaskSheet } from './task-sheets'

// An FLA's task sheets (rec#11 D-82), written fresh for direction A: one card
// per task, and inside it a to-do-like list of who does which share. A share
// shows its status, and a bar with its count only when the task's plan
// records its steps. The lead reads the sheet in its order; anyone else
// finds their own share first.
const props = defineProps<{ spaceId: string; agentId: string; agentName: string; projectName: (id: string) => string }>()

const sheets = ref<TaskSheet[]>([])
const partial = ref(false)
const state = ref<'loading' | 'ready' | 'failed'>('loading')
let controller: AbortController | null = null
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  state.value = 'loading'
  try {
    const result = await readTaskSheets(props.spaceId, props.agentId, current.signal)
    if (controller !== current) return
    sheets.value = result.workbenches
    partial.value = result.partial
    state.value = 'ready'
  } catch (cause) {
    if (controller !== current || (cause instanceof DOMException && cause.name === 'AbortError')) return
    state.value = 'failed'
    failure.value = cause instanceof ApiError && cause.status === 404 ? 'unsupported' : 'failed'
  }
}
const failure = ref<'failed' | 'unsupported'>('failed')
watch(() => [props.spaceId, props.agentId], () => { if (props.spaceId && props.agentId) void load() }, { immediate: true })
onBeforeUnmount(() => controller?.abort())

// Names for everyone holding a share, read once per sheet set.
const shareIds = computed(() => [...new Set(sheets.value.flatMap(sheet => sheet.shares.map(share => share.agentId)))])
const people = useAgentRecords(computed(() => props.spaceId), shareIds)
const nameOf = (agentId: string) => {
  if (agentId === props.agentId) return props.agentName
  const record = people.records.value[agentId]
  return record ? agentDisplayName(record) : t('flaPage.sheets.unknownAgent')
}
const known = (key: string, fallback: string) => { const label = t(key); return label === key ? fallback : label }
const statusLabel = (status: string) => known(`projectAgents.taskStatus.${status}`, status)
const roleLabel = (role: string | null) => (role ? known(`flaPage.sheets.roles.${role}`, '') : '')
</script>

<template>
  <section class="sheets" aria-labelledby="fla-sheets-heading" data-task-sheets>
    <h2 id="fla-sheets-heading" class="sheets-label">{{ t('flaPage.sheets.title') }} <span v-if="state === 'ready'" class="ui-num">{{ sheets.length }}</span></h2>
    <GrowthLoading v-if="state === 'loading' && !sheets.length" variant="compact" :label="t('flaPage.sheets.loading', { name: agentName })" />
    <div v-else-if="state === 'failed' && !sheets.length" class="sheets-empty" role="alert">
      <p>{{ t(failure === 'unsupported' ? 'flaPage.sheets.unsupported' : 'flaPage.sheets.failed') }}</p>
      <Button v-if="failure === 'failed'" size="sm" variant="ghost" @click="load">{{ t('flaPage.sheets.retry') }}</Button>
    </div>
    <p v-else-if="state === 'ready' && !sheets.length" class="sheets-empty">{{ t('flaPage.sheets.empty', { name: agentName }) }}</p>
    <p v-if="partial" class="sheets-note" role="status">{{ t('flaPage.sheets.partial') }}</p>

    <article v-for="sheet in sheets" :key="sheet.taskId" class="sheet" :data-task-sheet="sheet.taskId">
      <header class="sheet-head">
        <div class="sheet-heading">
          <p v-if="sheet.personalProjectId" class="sheet-project">{{ projectName(sheet.personalProjectId) }}</p>
          <h3 class="sheet-title">
            <RouterLink :to="{ path: agentManagementPath(spaceId, agentId), query: { task: sheet.taskId } }">{{ sheet.title }}</RouterLink>
          </h3>
        </div>
        <span class="sheet-status" :data-tone="statusTone(sheet.status)">{{ statusLabel(sheet.status) }}</span>
      </header>
      <p v-if="sheet.objective" class="sheet-objective">{{ sheet.objective }}</p>
      <UiNotice v-if="sheet.blocker" tone="warning">{{ sheet.blocker.summary || t('flaPage.sheets.blocked') }}</UiNotice>
      <ol class="sheet-shares" :aria-label="t('flaPage.sheets.shares')">
        <li v-for="share in sharesFor(sheet, agentId)" :key="share.agentId" class="share" :class="{ 'is-self': share.agentId === agentId }" :data-share="share.agentId">
          <RouterLink class="share-face" :to="agentProfilePath(spaceId, share.agentId)" :style="agentIdentityStyle(share.agentId)" :aria-label="nameOf(share.agentId)">
            <img :src="agentAvatarUrl(share.agentId)" alt="" />
          </RouterLink>
          <div class="share-main">
            <p class="share-who"><strong>{{ nameOf(share.agentId) }}</strong><span v-if="roleLabel(share.role)" class="share-role">{{ roleLabel(share.role) }}</span></p>
            <p v-if="share.assignment" class="share-assignment">{{ share.assignment }}</p>
          </div>
          <div class="share-state">
            <span class="share-status" :data-tone="statusTone(share.status)">{{ statusLabel(share.status) }}</span>
            <template v-if="shareFill(share.progress) !== null">
              <span class="share-bar" role="progressbar" :aria-valuenow="share.progress!.completed" aria-valuemin="0" :aria-valuemax="share.progress!.total"
                :aria-label="t('flaPage.sheets.progress', { completed: share.progress!.completed, total: share.progress!.total })">
                <i :style="{ transform: `scaleX(${shareFill(share.progress)})` }" />
              </span>
              <span class="share-count ui-num" aria-hidden="true">{{ share.progress!.completed }}/{{ share.progress!.total }}</span>
            </template>
          </div>
        </li>
      </ol>
      <p v-if="sheet.unassignedSteps" class="sheets-note">{{ t('flaPage.sheets.unassigned', { count: sheet.unassignedSteps }) }}</p>
    </article>
  </section>
</template>

<style scoped>
.sheets { display: grid; gap: 12px; }
.sheets-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.sheets-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.sheets-empty { display: grid; justify-items: center; gap: 8px; margin: 0; padding: 32px 16px; border-radius: var(--radius-card); color: var(--color-muted); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); text-align: center; }
.sheets-empty p { margin: 0; }
.sheets-note { margin: 0; padding-inline: 4px; color: var(--color-muted); font-size: var(--text-meta); }
/* One task: a white card with its shares as a checklist-like list inside. */
.sheet { display: grid; gap: 12px; padding: 18px 20px 14px; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.sheet-heading { display: grid; gap: 2px; min-width: 0; }
.sheet-project { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.sheet-title { margin: 0; font-size: var(--text-card-title); font-weight: var(--weight-strong); line-height: var(--leading-heading); overflow-wrap: anywhere; }
.sheet-title a { color: inherit; text-decoration: none; }
.sheet-title a:hover { text-decoration: underline; text-underline-offset: 3px; }
.sheet-status, .share-status { flex: none; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.sheet-status { padding: 2px 10px; border-radius: var(--radius-pill); background: var(--color-surface-subtle); }
:is(.sheet-status, .share-status)[data-tone="success"] { color: var(--color-success); }
:is(.sheet-status, .share-status)[data-tone="warning"] { color: var(--color-warning); }
:is(.sheet-status, .share-status)[data-tone="danger"] { color: var(--color-danger); }
.sheet-objective { display: -webkit-box; margin: 0; overflow: hidden; color: var(--color-ink-soft); font-size: var(--text-control); line-height: var(--leading-prose); -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.sheet-shares { margin: 0; padding: 0; list-style: none; }
.share { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 8px; border-radius: var(--radius-control); }
.share + .share { box-shadow: 0 -1px 0 var(--color-border); }
/* The FLA whose page this is: a quiet surface, never a side bar. */
.share.is-self { background: var(--color-surface-subtle); box-shadow: none; }
.share.is-self + .share { box-shadow: none; }
.share-face { display: grid; width: 32px; height: 32px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-surface-hover)); }
.share-face img { width: 100%; height: 100%; object-fit: cover; }
.share-face:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.share-main { display: grid; gap: 2px; min-width: 0; }
.share-who { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: var(--text-body); }
.share-who strong { font-weight: var(--weight-medium); }
.share-role { color: var(--color-muted); font-size: var(--text-meta); }
.share-assignment { margin: 0; overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.share-state { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
/* The bar grows on the shared spring when a step completes; reduced motion shows the new value at once. */
.share-bar { position: relative; width: 88px; height: 5px; overflow: hidden; border-radius: 5px; background: var(--color-surface-hover); }
.share-bar i { position: absolute; inset: 0; border-radius: inherit; background: var(--color-gold); transform-origin: left center; transition: transform var(--motion-spring) var(--motion-ease-spring); }
.share-count { min-width: 30px; color: var(--color-muted); font-size: var(--text-meta); text-align: right; }
@media (max-width: 640px) {
  .share { grid-template-columns: 32px minmax(0, 1fr); }
  .share-state { grid-column: 2; justify-content: flex-start; }
}
</style>
