<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { RouterLink } from 'vue-router'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
import { agentManagementPath } from '@/features/project-agents/orchestration-filters'
import { statusTone } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import TeamFaces from './TeamFaces.vue'
import { currentStep, fill, sharesFor, stepsOf, type TeamSheet } from './team-sheets'

// 团队卡片: one task several FLAs do together. Folded, it shows who is on it
// (rings = each share's recorded progress), what is happening now and the
// whole task's count; open, each share's own to-do list with its bar. It
// assumes nothing about where it sits.
const props = defineProps<{
  sheet: TeamSheet
  spaceId: string
  nameOf: (agentId: string) => string
  projectName: (projectId: string) => string
  /** The FLA whose page shows this card: its share comes first. */
  viewerAgentId?: string | null
  defaultOpen?: boolean
}>()
const open = ref(Boolean(props.defaultOpen))
const bodyId = useId()

const shares = computed(() => sharesFor(props.sheet, props.viewerAgentId ?? null))
const faces = computed(() => shares.value.map(share => ({
  agentId: share.agentId,
  lead: share.agentId === props.sheet.leadAgentId,
  fill: fill(share.progress),
  working: Boolean(currentStep(props.sheet, share.agentId)),
})))
// What is happening now: the first share with a step in progress.
const now = computed(() => {
  for (const share of shares.value) {
    const step = currentStep(props.sheet, share.agentId)
    if (step) return t('teamWork.card.now', { name: props.nameOf(share.agentId), step: step.title })
  }
  return ''
})
const known = (key: string, fallback: string) => { const label = t(key); return label === key ? fallback : label }
const statusLabel = (status: string) => known(`projectAgents.taskStatus.${status}`, status)
const roleLabel = (role: string | null) => (role ? known(`teamWork.card.roles.${role}`, '') : '')
const total = computed(() => fill(props.sheet.progress))
</script>

<template>
  <article class="team-card" :class="{ 'is-open': open }" :data-team-card="sheet.taskId" data-term="work.teamCard">
    <button type="button" class="team-head" :aria-expanded="open" :aria-controls="bodyId" @click="open = !open">
      <TeamFaces :faces="faces" />
      <span class="team-text">
        <span class="team-title">{{ sheet.title }}</span>
        <span class="team-meta">
          <template v-if="sheet.personalProjectId">{{ projectName(sheet.personalProjectId) }} · </template>{{ t('teamWork.card.flas', { count: sheet.shares.length }) }}<template v-if="now"> · <span class="team-now">{{ now }}</span></template>
        </span>
      </span>
      <span class="team-total">
        <template v-if="total !== null">
          <span class="team-bar" role="progressbar" :aria-valuenow="sheet.progress!.completed" aria-valuemin="0" :aria-valuemax="sheet.progress!.total"
            :aria-label="t('teamWork.card.progress', { completed: sheet.progress!.completed, total: sheet.progress!.total })"><i :style="{ transform: `scaleX(${total})` }" /></span>
          <span class="team-count ui-num" aria-hidden="true">{{ sheet.progress!.completed }}/{{ sheet.progress!.total }}</span>
        </template>
        <span v-else class="team-status" :data-tone="statusTone(sheet.status)">{{ statusLabel(sheet.status) }}</span>
      </span>
      <UiIcon name="chevron-down" :size="16" class="team-chevron" />
    </button>
    <!-- Opens by its height on the shared motion; interrupting it just reverses. -->
    <div :id="bodyId" class="team-body" :inert="!open">
      <div class="team-body-inner">
        <p v-if="sheet.blocker" class="team-blocker" role="status">{{ sheet.blocker.summary || t('teamWork.card.blocked') }}</p>
        <ol class="team-shares" :aria-label="t('teamWork.card.shares')">
          <li v-for="share in shares" :key="share.agentId" class="team-share" :class="{ 'is-self': share.agentId === viewerAgentId }" :data-team-share="share.agentId">
            <div class="team-share-head">
              <RouterLink class="team-share-name" :to="agentProfilePath(spaceId, share.agentId)">{{ nameOf(share.agentId) }}</RouterLink>
              <span v-if="roleLabel(share.role)" class="team-share-role">{{ roleLabel(share.role) }}</span>
              <span class="team-share-state">
                <template v-if="fill(share.progress) !== null">
                  <span class="team-bar is-small" role="progressbar" :aria-valuenow="share.progress!.completed" aria-valuemin="0" :aria-valuemax="share.progress!.total"
                    :aria-label="t('teamWork.card.progress', { completed: share.progress!.completed, total: share.progress!.total })"><i :style="{ transform: `scaleX(${fill(share.progress)})` }" /></span>
                  <span class="team-count ui-num" aria-hidden="true">{{ share.progress!.completed }}/{{ share.progress!.total }}</span>
                </template>
                <span v-else class="team-status" :data-tone="statusTone(share.status)">{{ statusLabel(share.status) }}</span>
              </span>
            </div>
            <p v-if="share.assignment" class="team-share-assignment">{{ share.assignment }}</p>
            <ul v-if="stepsOf(sheet, share.agentId).length" class="team-steps">
              <li v-for="step in stepsOf(sheet, share.agentId)" :key="step.id" class="team-step" :data-step-status="step.status">
                <span class="team-check" aria-hidden="true"><UiIcon v-if="step.status === 'completed'" name="check" :size="11" /></span>
                <span class="team-step-title">{{ step.title }}</span>
                <span class="ui-sr-only">{{ statusLabel(step.status) }}</span>
              </li>
            </ul>
          </li>
        </ol>
        <p v-if="sheet.unassignedSteps" class="team-note">{{ t('teamWork.card.unassigned', { count: sheet.unassignedSteps }) }}</p>
        <RouterLink class="team-open" :to="{ path: agentManagementPath(spaceId, sheet.leadAgentId ?? shares[0]!.agentId), query: { task: sheet.taskId } }">
          {{ t('teamWork.card.open') }}<UiIcon name="chevron-right" :size="14" />
        </RouterLink>
      </div>
    </div>
  </article>
</template>

<style scoped>
.team-card { border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); transition: box-shadow var(--motion-move); }
/* Open, the card lifts a little: the one being read stands apart without a side bar. */
.team-card.is-open { box-shadow: 0 0 0 1px var(--color-border), var(--shadow-md); }
.team-head {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto 16px; align-items: center; gap: 14px; width: 100%; padding: 14px 16px;
  border: 0; border-radius: inherit; color: var(--color-ink); background: none; font: inherit; text-align: left; cursor: pointer;
}
.team-head:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.team-text { display: grid; gap: 2px; min-width: 0; }
.team-title { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-strong); text-overflow: ellipsis; white-space: nowrap; }
.team-meta { overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.team-now { color: var(--color-ink-soft); }
.team-total, .team-share-state { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.team-bar { position: relative; width: 72px; height: 5px; overflow: hidden; border-radius: 5px; background: var(--color-surface-hover); }
.team-bar.is-small { width: 56px; height: 4px; }
.team-bar i { position: absolute; inset: 0; border-radius: inherit; background: var(--color-gold); transform-origin: left center; transition: transform var(--motion-spring) var(--motion-ease-spring); }
.team-count { min-width: 28px; color: var(--color-muted); font-size: var(--text-meta); text-align: right; }
.team-status { color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.team-status[data-tone="warning"] { color: var(--color-warning); }
.team-status[data-tone="danger"] { color: var(--color-danger); }
.team-status[data-tone="success"] { color: var(--color-success); }
.team-chevron { color: var(--color-faint); transition: transform var(--motion-move); }
.is-open .team-chevron { transform: rotate(180deg); }
.team-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--motion-move); }
.is-open .team-body { grid-template-rows: 1fr; }
.team-body-inner { display: grid; gap: 10px; min-height: 0; overflow: hidden; padding: 0 16px; }
.is-open .team-body-inner { padding-bottom: 14px; }
.team-blocker { margin: 0; padding: 8px 12px; border-radius: var(--radius-control); color: var(--color-warning); background: var(--color-warning-soft); font-size: var(--text-control); }
.team-shares { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.team-share { display: grid; gap: 4px; padding: 10px 12px; border-radius: var(--radius-control); }
.team-share + .team-share { box-shadow: 0 -1px 0 var(--color-border); }
.team-share.is-self { background: var(--color-surface-subtle); box-shadow: none; }
.team-share.is-self + .team-share { box-shadow: none; }
.team-share-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.team-share-name { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); text-decoration: none; }
.team-share-name:hover { text-decoration: underline; text-underline-offset: 3px; }
.team-share-role { color: var(--color-muted); font-size: var(--text-meta); }
.team-share-state { margin-left: auto; }
.team-share-assignment { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.team-steps { display: grid; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
.team-step { display: flex; align-items: center; gap: 8px; color: var(--color-ink-soft); font-size: var(--text-control); }
.team-check { display: grid; flex: none; width: 16px; height: 16px; place-items: center; border-radius: 50%; color: var(--color-on-accent); box-shadow: inset 0 0 0 1.5px var(--color-control-border); }
.team-step[data-step-status="completed"] .team-check { background: var(--color-accent); box-shadow: none; }
.team-step[data-step-status="completed"] .team-step-title { color: var(--color-muted); text-decoration: line-through; text-decoration-color: var(--color-faint); }
.team-step[data-step-status="in_progress"] .team-check { box-shadow: inset 0 0 0 1.5px var(--color-gold); animation: team-step-breathe var(--motion-pulse) ease-in-out infinite; }
.team-step[data-step-status="in_progress"] .team-step-title { color: var(--color-ink); font-weight: var(--weight-medium); }
@keyframes team-step-breathe { 50% { box-shadow: inset 0 0 0 1.5px var(--color-gold), 0 0 0 4px var(--color-gold-soft); } }
.team-note { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.team-open { display: inline-flex; align-items: center; gap: 2px; justify-self: end; color: var(--color-link); font-size: var(--text-control); text-decoration: none; }
@media (max-width: 640px) {
  .team-head { grid-template-columns: auto minmax(0, 1fr) 16px; }
  .team-total { grid-column: 2; }
}
</style>
