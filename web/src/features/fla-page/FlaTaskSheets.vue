<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useRoute } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import TeamCard from '@/features/team-work/TeamCard.vue'
import { isOpenSheet } from '@/features/team-work/team-sheets'
import { t } from '@/i18n'
import { useAgentSheets } from './agent-sheets'

// Widget 'fla-sheets' (手上的活): every unfinished task this FLA takes part in
// (rec#11 D-82), each as the same 团队卡片 the home page shows, with this FLA's
// own share first. Every card starts folded on its current step and count:
// 现在 above already says what it is doing. A link that names a task
// (?task=) opens that card with all its steps. Finished work is 最近做完's,
// further down the page.
const props = defineProps<{ spaceId: string; agentId: string; agentName: string; projectName: (id: string) => string }>()

const route = useRoute()
const linked = computed(() => (typeof route.query.task === 'string' ? route.query.task : ''))
const read = useAgentSheets(toRef(props, 'spaceId'), toRef(props, 'agentId'))
const sheets = computed(() => read.sheets.value.filter(isOpenSheet))
const state = read.state

// Names for everyone holding a share, read once per sheet set.
const shareIds = computed(() => [...new Set(sheets.value.flatMap(sheet => sheet.shares.map(share => share.agentId)))])
const people = useAgentRecords(computed(() => props.spaceId), shareIds)
const nameOf = (agentId: string) => {
  if (agentId === props.agentId) return props.agentName
  const record = people.records.value[agentId]
  return record ? agentDisplayName(record) : t('flaPage.sheets.unknownAgent')
}
</script>

<template>
  <section class="sheets" aria-labelledby="fla-sheets-heading" data-task-sheets data-widget="fla-sheets">
    <h2 id="fla-sheets-heading" class="sheets-label">{{ t('flaPage.sheets.title') }} <span v-if="state === 'ready'" class="ui-num">{{ sheets.length }}</span></h2>
    <GrowthLoading v-if="state === 'loading' && !sheets.length" variant="compact" :label="t('flaPage.sheets.loading', { name: agentName })" />
    <div v-else-if="state === 'failed' && !sheets.length" class="sheets-empty" role="alert">
      <p>{{ t(read.unsupported.value ? 'flaPage.sheets.unsupported' : 'flaPage.sheets.failed') }}</p>
      <Button v-if="!read.unsupported.value" size="sm" variant="ghost" @click="read.reload()">{{ t('flaPage.sheets.retry') }}</Button>
    </div>
    <p v-else-if="state === 'ready' && !sheets.length" class="sheets-empty">{{ t('flaPage.sheets.empty', { name: agentName }) }}</p>
    <p v-if="read.partial.value" class="sheets-note" role="status">{{ t('flaPage.sheets.partial') }}</p>
    <TransitionGroup name="ui-list" tag="div" class="sheets-list">
      <TeamCard v-for="sheet in sheets" :key="`${sheet.taskId}:${sheet.taskId === linked}`" :sheet="sheet" :space-id="spaceId" :name-of="nameOf"
        :project-name="projectName" :viewer-agent-id="agentId" :default-open="sheet.taskId === linked" focused />
    </TransitionGroup>
  </section>
</template>

<style scoped>
.sheets { display: grid; gap: 8px; }
.sheets-label { display: flex; align-items: baseline; gap: 8px; margin: 0; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.sheets-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.sheets-empty { display: grid; justify-items: start; gap: 8px; margin: 0; padding: 12px 16px; border-radius: var(--radius-card); color: var(--color-muted); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.sheets-empty p { margin: 0; }
.sheets-note { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.sheets-list { display: grid; gap: 8px; }
</style>
