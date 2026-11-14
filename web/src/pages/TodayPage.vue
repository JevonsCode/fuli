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

// 今天, the home page, in two halves like the workbench: on the left the
// compounding statement, the one thing to look at, which never scrolls; on the
// right the lists (what needs the person's call, what their assistants did
// today, who is working now), which scroll. A section with nothing to show is
// not there, and with no statement the lists take the whole width. The
// statement is read first and a list appears only once every list above it
// has been read, so a later answer only adds below and nothing on screen moves.
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
const hasStatement = computed(() => shows('statement') && Boolean(today.statement.value.value))
const hasLists = computed(() => today.shown.value.some(section => section !== 'statement'))
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
    <div v-else class="today-board" :class="{ 'has-statement': hasStatement }">
      <TodayStatement v-if="hasStatement" :statement="today.statement.value.value!" :total="today.total.value" :tiles="today.tiles.value" />
      <div class="today-feed" data-today-feed>
      <TodayDecisions v-if="shows('decisions')" :rows="today.decisions.value.rows" :more="today.decisions.value.more" :visits="today.decisions.value.visits" :agent-name="overview.agentName" />
      <TodaySection v-if="shows('done')" :title="t('today.sections.done')" data-today-section="done">
        <template #action>
          <Button as-child variant="ghost" size="sm"><RouterLink to="/workbench/notices" data-today-action="done">{{ t('today.actions.earlier') }}</RouterLink></Button>
        </template>
        <ul class="workbench-rows">
          <li v-for="item in today.done.value" :key="item.id"><NoticeRow :item="item" /></li>
        </ul>
      </TodaySection>
      <TodayWorking v-if="shows('working')" :rows="today.working.value" :space-id="activeSpaceId" :name="workerName" :project="projectName" />
      <!-- One indicator for the next section still being read, always below what is shown. -->
      <GrowthLoading v-if="today.pending.value" variant="compact" :label="pendingLabel" />
      <!-- A statement with no list beside it: the right half says the one thing there is to do. -->
      <TodayEmpty v-else-if="!hasLists" />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The page fills the window and never scrolls; the right half does. The left
   card stops above the dock; the lists scroll under it. */
/* 今天 is all frame: counts, labels and rows that lead elsewhere. Nothing here is text to copy. */
.today-view { -webkit-user-select: none; user-select: none; }
.today-view { display: flex; overflow: hidden; padding-bottom: 20px !important; overflow-wrap: anywhere; }
.today-board { display: grid; flex: 1; grid-template-columns: minmax(0, 1fr); gap: 18px; width: 100%; min-height: 0; }
.today-board.has-statement { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.today-board.has-statement > :first-child { margin-bottom: 76px; }
.today-feed { display: flex; flex-direction: column; gap: 16px; min-width: 0; min-height: 0; padding: 0 6px 112px 0; overflow: auto; overscroll-behavior: contain; }
/* Small windows and phones: one column, the statement first, the page scrolls. */
@media (max-width: 860px) {
  .today-view { display: block; overflow: auto; padding-bottom: calc(112px + env(safe-area-inset-bottom)) !important; }
  .today-board, .today-board.has-statement { display: flex; flex-direction: column; }
  .today-board.has-statement > :first-child { margin-bottom: 0; }
  .today-feed { padding: 0; overflow: visible; }
}
</style>
