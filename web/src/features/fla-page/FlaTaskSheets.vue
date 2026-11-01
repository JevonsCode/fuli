<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import TeamCard from '@/features/team-work/TeamCard.vue'
import { readAgentSheets, type TeamSheet } from '@/features/team-work/team-sheets'
import { t } from '@/i18n'

// Widget 'fla-sheets': every task this FLA takes part in (rec#11 D-82), each
// as the same 团队卡片 the home page shows, with this FLA's own share first.
// The first card opens so its own to-do list is in view.
const props = defineProps<{ spaceId: string; agentId: string; agentName: string; projectName: (id: string) => string }>()

const sheets = ref<TeamSheet[]>([])
const partial = ref(false)
const state = ref<'loading' | 'ready' | 'failed'>('loading')
const failure = ref<'failed' | 'unsupported'>('failed')
let controller: AbortController | null = null
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  state.value = 'loading'
  try {
    const result = await readAgentSheets(props.spaceId, props.agentId, current.signal)
    if (controller !== current) return
    sheets.value = result.workbenches
    partial.value = result.partial
    state.value = 'ready'
  } catch (cause) {
    if (controller !== current || (cause instanceof DOMException && cause.name === 'AbortError')) return
    state.value = 'failed'
    failure.value = (cause as { status?: unknown } | null)?.status === 404 ? 'unsupported' : 'failed'
  }
}
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
</script>

<template>
  <section class="sheets" aria-labelledby="fla-sheets-heading" data-task-sheets data-widget="fla-sheets">
    <h2 id="fla-sheets-heading" class="sheets-label">{{ t('flaPage.sheets.title') }} <span v-if="state === 'ready'" class="ui-num">{{ sheets.length }}</span></h2>
    <GrowthLoading v-if="state === 'loading' && !sheets.length" variant="compact" :label="t('flaPage.sheets.loading', { name: agentName })" />
    <div v-else-if="state === 'failed' && !sheets.length" class="sheets-empty" role="alert">
      <p>{{ t(failure === 'unsupported' ? 'flaPage.sheets.unsupported' : 'flaPage.sheets.failed') }}</p>
      <Button v-if="failure === 'failed'" size="sm" variant="ghost" @click="load">{{ t('flaPage.sheets.retry') }}</Button>
    </div>
    <p v-else-if="state === 'ready' && !sheets.length" class="sheets-empty">{{ t('flaPage.sheets.empty', { name: agentName }) }}</p>
    <p v-if="partial" class="sheets-note" role="status">{{ t('flaPage.sheets.partial') }}</p>
    <TransitionGroup name="ui-list" tag="div" class="sheets-list">
      <TeamCard v-for="(sheet, index) in sheets" :key="sheet.taskId" :sheet="sheet" :space-id="spaceId" :name-of="nameOf"
        :project-name="projectName" :viewer-agent-id="agentId" :default-open="index === 0" />
    </TransitionGroup>
  </section>
</template>

<style scoped>
.sheets { display: grid; gap: 12px; }
.sheets-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.sheets-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.sheets-empty { display: grid; justify-items: center; gap: 8px; margin: 0; padding: 32px 16px; border-radius: var(--radius-card); color: var(--color-muted); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); text-align: center; }
.sheets-empty p { margin: 0; }
.sheets-note { margin: 0; padding-inline: 4px; color: var(--color-muted); font-size: var(--text-meta); }
.sheets-list { display: grid; gap: 8px; }
</style>
