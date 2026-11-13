<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import NoticeRow from '@/features/overview/NoticeRow.vue'
import { useScopeBootstrap } from '@/features/overview/useScopeBootstrap'
import ProblemState from '@/features/problem/ProblemState.vue'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { projectDisplayName } from '@/features/projects/project-origin'
import { useTeamPeople } from '@/features/team-work/useTeamPeople'
import TodayDecisions from '@/features/today/TodayDecisions.vue'
import TodayEmpty from '@/features/today/TodayEmpty.vue'
import TodaySection from '@/features/today/TodaySection.vue'
import TodayStatement from '@/features/today/TodayStatement.vue'
import TodayWorking from '@/features/today/TodayWorking.vue'
import type { WorkingRow } from '@/features/today/today-model'
import { useTodayData, type TodaySection as TodaySectionId } from '@/features/today/useTodayData'
import { t } from '@/i18n'
import { usePageRefresh } from '@/layouts/page-refresh'
import { useConsoleStore } from '@/stores/console'

// 今天, the home page: one column of plain cards answering what needs the
// person's call, what their assistants did today, whether it is adding up,
// and who is working now. A section with nothing to show is not there. A
// section appears only once every section above it has been read, so a later
// answer only adds below and nothing already on screen moves.
const store = useConsoleStore()
const attentionCache = useAgentAttention()
const activeSpaceId = computed(() => store.activePersonalSpace?.id ?? store.state?.activePersonalSpaceId ?? '')
const projects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === activeSpaceId.value))
const projectNames = computed(() => new Map(projects.value.map(project => [project.project_id, projectDisplayName(project)])))
const today = useTodayData(activeSpaceId, projects)
const { overview } = today
watch(overview.denied, denied => { if (denied) attentionCache.setSpace('') }, { flush: 'sync' })
const scope = useScopeBootstrap(overview.denied, () => { attentionCache.setSpace(activeSpaceId.value); overview.retryScope() })
const people = useTeamPeople(activeSpaceId, today.team.sheets)

const shows = (section: TodaySectionId) => today.shown.value.includes(section)
const pendingLabel = computed(() => today.pending.value ? t(`today.loading.${today.pending.value}`) : '')
const empty = computed(() => !today.pending.value && !today.shown.value.length)
function workerName(row: WorkingRow) {
  if (!row.agentId) return t('overview.missing.owner')
  return row.team ? people.nameOf(row.agentId) : overview.agentName(row.agentId)
}
function projectName(id: string | null) { return (id && projectNames.value.get(id)) || t('overview.missing.project') }
// The top bar's 刷新 reads every section again in place.
usePageRefresh(today.reload)
</script>

<template>
  <section class="view today-view">
    <template v-if="scope.loading.value">
      <GrowthLoading :label="t('overview.read.scope')" />
      <p v-if="scope.slow.value" role="status">{{ t('overview.read.slow') }}</p>
    </template>
    <ProblemState v-else-if="scope.failed.value" :title="scope.problem.value.title" :detail="scope.problem.value.detail"
      :error="scope.error.value" :retrying="scope.retrying.value" :retrying-label="t('overview.read.scope')" @retry="scope.retry" />
    <GrowthLoading v-else-if="!today.shown.value.length && today.pending.value" :label="pendingLabel" />
    <TodayEmpty v-else-if="empty" />
    <div v-else class="today-stack">
      <TodayDecisions v-if="shows('decisions')" :rows="today.decisions.value.rows" :more="today.decisions.value.more" :agent-name="overview.agentName" />
      <TodaySection v-if="shows('done')" :title="t('today.sections.done')" data-today-section="done">
        <template #action>
          <Button as-child variant="ghost" size="sm"><RouterLink to="/workbench/notices" data-today-action="done">{{ t('today.actions.earlier') }}</RouterLink></Button>
        </template>
        <ul class="workbench-rows">
          <li v-for="item in today.done.value" :key="item.id"><NoticeRow :item="item" /></li>
        </ul>
      </TodaySection>
      <TodayStatement v-if="shows('statement') && today.statement.value.value" :statement="today.statement.value.value"
        :total="today.total.value" :tiles="today.tiles.value" />
      <TodayWorking v-if="shows('working')" :rows="today.working.value" :name="workerName" :project="projectName" />
      <!-- One indicator for the next section still being read, always below what is shown. -->
      <GrowthLoading v-if="today.pending.value" variant="compact" :label="pendingLabel" />
    </div>
  </section>
</template>

<style scoped>
.today-view { overflow-wrap: anywhere; }
.today-stack { display: grid; align-content: start; gap: 16px; min-width: 0; }
</style>
