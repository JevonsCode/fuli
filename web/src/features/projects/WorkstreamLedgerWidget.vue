<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { ApiError } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import { personalProjectsPath } from '@/router/paths'
import { UiChip, UiNotice } from '@/ui'
import { readAgentWorkstreams, type AgentWorkstreamLedger, type ProjectWorkstream } from './project-team-api'

// The lead's ledger as a widget (widgets/registry.ts): it reads its own data
// and takes only the FLA of wherever it sits. One row answers which project,
// which line, who and how far. Changing a line is the project page's job, one
// click away, so the same change is never in two places. Lines are read only
// on this computer; over the LAN the widget says so instead of retrying.

const props = defineProps<{ spaceId?: string; agentId?: string }>()

const ledger = ref<AgentWorkstreamLedger | null>(null)
const loading = ref(false)
const failed = ref<'local_only' | 'failed' | null>(null)
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !ledger.value))
let sequence = 0

const groups = computed(() => ledger.value?.projects ?? [])

watch(() => [props.spaceId, props.agentId], () => {
  ledger.value = null
  void load()
}, { immediate: true })

async function load() {
  if (!props.agentId) return
  const current = ++sequence
  loading.value = true
  failed.value = null
  try {
    const value = await readAgentWorkstreams(props.agentId)
    if (current === sequence) ledger.value = value
  } catch (error) {
    if (current === sequence) failed.value = localOnly(error) ? 'local_only' : 'failed'
  } finally {
    if (current === sequence) loading.value = false
  }
}

function localOnly(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 403) return false
  try { return JSON.parse(error.detail)?.code === 'local_user_only' } catch { return false }
}

function progress(line: ProjectWorkstream) {
  if (line.progressUnreadable) return t('projects.workstreams.progressUnreadable')
  if (!line.latestTask) return t('projects.workstreams.noTask')
  return t('projects.workstreams.latestTask', {
    status: taskStatusLabel(line.latestTask.status ?? '', { unrecognized: t('projects.workstreams.unknownStatus') }),
    title: line.latestTask.summary ?? '',
    date: formatDateTime(line.latestTask.at, currentLocale(), DATE_ONLY, { missing: '' }),
  })
}
</script>

<template>
  <section v-if="showLoading || failed || groups.length" class="workstream-ledger"
    data-workstream-ledger aria-labelledby="workstream-ledger-heading">
    <header class="workstream-ledger-header">
      <h3 id="workstream-ledger-heading">{{ t('projects.workstreams.ledger') }}</h3>
      <span class="ui-meta">{{ t('projects.workstreams.ledgerHint') }}</span>
    </header>

    <GrowthLoading v-if="showLoading" variant="compact" :label="t('projects.workstreams.loading')" />
    <UiNotice v-else-if="failed === 'local_only'" tone="info" data-ledger-local-only>
      {{ t('projects.workstreams.localOnly') }}
    </UiNotice>
    <UiNotice v-else-if="failed" tone="error">
      {{ t('projects.workstreams.failed') }}
      <template #actions><Button size="sm" variant="ghost" @click="load">{{ t('projects.overview.retry') }}</Button></template>
    </UiNotice>

    <ul v-else class="workstream-ledger-list">
      <li v-for="group in groups" :key="group.projectId" class="workstream-ledger-group"
        :data-ledger-project="group.projectId">
        <RouterLink v-if="spaceId" class="workstream-ledger-project"
          :to="personalProjectsPath(spaceId, 'overview', group.projectId)">{{ group.projectName }}</RouterLink>
        <span v-else class="workstream-ledger-project">{{ group.projectName }}</span>
        <ul class="workstream-ledger-lines">
          <li v-for="line in group.workstreams" :key="line.assignmentId" class="workstream-ledger-line"
            :data-ledger-workstream="line.assignmentId">
            <strong>{{ line.name }}</strong>
            <span class="workstream-ledger-owner">{{ line.ownerName ?? line.ownerAgentId }}</span>
            <UiChip v-if="!line.ownerOnProject" tone="warning" data-owner-gone>{{ t('projects.workstreams.ownerLeft') }}</UiChip>
            <span class="ui-meta">{{ progress(line) }}</span>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.workstream-ledger-header {
  align-items: baseline;
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
}

.workstream-ledger-list,
.workstream-ledger-lines {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.workstream-ledger-group {
  margin-top: 0.5rem;
}

.workstream-ledger-project {
  font-size: 0.875rem;
  font-weight: 600;
}

.workstream-ledger-line {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.workstream-ledger-owner {
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
</style>
