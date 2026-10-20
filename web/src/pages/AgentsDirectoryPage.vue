<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import BackToTop from "@/components/BackToTop.vue";
import GrowthLoading from "@/components/GrowthLoading.vue";
import { focusReturnTarget, useFocusReturn } from "@/composables/useFocusReturn";
import { useNearEnd } from "@/composables/useNearEnd";
import { useRoutePeek } from "@/composables/useRoutePeek";
import { useScrollRestoration } from "@/composables/useScrollRestoration";
import AgentPeek from "@/features/agent-profile/AgentPeek.vue";
import { useAgentRecords } from "@/features/agent-profile/useAgentRecords";
import {
  directoryFilterQuery,
  readDirectoryFilters,
  sameDirectoryFilters,
  type DirectorySort,
  type DirectoryStatus,
  type DirectoryView,
} from "@/features/agent-profile/directory-query";
import { groupAgentsByProject } from "@/features/agent-profile/directory-project-groups";
import DirectoryProjectGroup from "@/features/agent-profile/DirectoryProjectGroup.vue";
import UnassignedConversationsPanel from "@/features/agent-profile/UnassignedConversationsPanel.vue";
import AgentCard from "@/features/agent-profile/AgentCard.vue";
import { isFormalProject, projectDisplayName } from "@/features/projects/project-origin";
import {
  agentDisplayName,
  agentProfilePath,
  fuzzyMatch,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import { agentPinsText, useAgentPinsState } from "@/features/agent-profile/agent-pins";
import { useAgentRosterPages } from "@/features/agent-profile/useAgentRosterPages";
import ProjectAgentFirstTask from "@/features/project-agents/ProjectAgentFirstTask.vue";
import { useAgentWorkSummary } from "@/features/agent-profile/useAgentWorkSummary";
import { agentWorkbenchEntry, compareWorkbenchRows } from "@/features/agent-profile/agent-workbench";
import { useStableOrder } from "@/features/agent-profile/useStableOrder";
import UiSegmented from "@/ui/UiSegmented.vue";
import UiSelect from "@/ui/UiSelect.vue";
import UiIconButton from "@/ui/UiIconButton.vue";
import EmployeeRecruitDialog from "@/features/employees/EmployeeRecruitDialog.vue";
import EmployeeWorkbenchLinks from "@/features/employees/EmployeeWorkbenchLinks.vue";
import { employeeTemplates } from "@/features/employees/catalog";
import { useConsoleStore } from "@/stores/console";
import { currentLocale, t } from "@/i18n";
import type { EmployeeRecruitmentResult } from "@/features/employees/catalog";
import type { PersonalProject } from "@/types";

const store = useConsoleStore();
const route = useRoute();
const router = useRouter();
const space = computed(() => store.activePersonalSpace?.id ?? "");
const agentPins = useAgentPinsState(space);
const pinnedAgentIds = agentPins.agentIds;
const pinSavingAgentId = agentPins.savingAgentId;
const pinError = agentPins.error;
const pinRetryLabel = computed(() => agentPinsText("retry", "Retry"));
const {
  summaries: workSummaries,
  tasks: workTasks,
  loading: workLoading,
  error: workError,
  state: workState,
  load: loadWorkSummary,
} = useAgentWorkSummary(space);
const initialFilters = readDirectoryFilters(route.query);
const search = ref(initialFilters.search);
const status = ref<string>(initialFilters.status);
// No selected project means every project.
const selectedProjects = ref<string[]>(initialFilters.projects);
const view = ref<DirectoryView>(initialFilters.view);
// Status narrows the request itself; search and projects filter the pages read so far.
const {
  agents,
  loading: pageLoading,
  error: pageError,
  complete: rosterComplete,
  loadMore,
  reload,
} = useAgentRosterPages(space, status);
const firstPageLoading = computed(() => pageLoading.value && !agents.value.length);
const partialRoster = computed(() => !rosterComplete.value && agents.value.length > 0);
const filtering = computed(() => Boolean(search.value.trim() || selectedProjects.value.length));
// Opened project groups; each opened project reads its own lead once.
const openProjects = ref<Record<string, boolean>>({});
const scroller = ref<HTMLElement | null>(null);
const rosterEnd = ref<HTMLElement | null>(null);
const nearEnd = useNearEnd(rosterEnd, scroller);
const recruiting = ref(false);
const hireable = computed(() => employeeTemplates.value.some((entry) => !entry.fixed));
const managesAllProjects = (agentId: string) => employeeTemplates.value
  .some((entry) => entry.agentId === agentId && entry.management?.mode === "all");

const allSpaceProjects = computed(() =>
  (store.state?.personalProjects ?? []).filter(
    (project) => project.personal_space_id === space.value,
  ),
);
const projects = computed(() =>
  allSpaceProjects.value.filter((project) => isFormalProject(project)),
);
const projectById = computed(() =>
  new Map(projects.value.map((project) => [project.project_id, project])),
);
const options = computed(() =>
  projects.value.map((project) => ({ value: project.project_id, label: project.profile.name })),
);
// Every project in the space gets a readable name, session fallbacks too,
// so an Agent card never shows a raw project id.
const projectNames = computed<Record<string, string>>(() =>
  Object.fromEntries(allSpaceProjects.value.map((project) => [project.project_id, projectDisplayName(project)])),
);
const statusOptions = computed(() => [
  { value: "all", label: t("agentProfiles.allStatus") },
  ...["active", "inactive", "archived"].map((value) => ({ value, label: t(`projectAgents.status.${value}`) })),
]);

const matches = (agent: (typeof agents.value)[number]) =>
  (status.value === "all" || agent.profile.status === status.value) &&
  (!selectedProjects.value.length ||
    profileProjectIds(agent).some((id) => selectedProjects.value.includes(id))) &&
  fuzzyMatch(
    [
      agentDisplayName(agent),
      agent.employeeNumber ? `FLA ${agent.employeeNumber}` : "",
      agent.profile.responsibility,
      ...agent.profile.capabilities,
      ...profileProjectIds(agent).map((id) => projectNames.value[id] || id),
    ].join(" "),
    search.value,
  );
const busy = computed(
  () =>
    firstPageLoading.value ||
    workLoading.value ||
    store.runtimeStatus === "loading",
);
const entries = computed(() =>
  Object.fromEntries(
    agents.value.map((agent) => [
      agent.agentId,
      agentWorkbenchEntry(agent, {
        summary: workSummaries.value[agent.agentId],
        summaryState: workState.value,
        tasks: workTasks.value,
      }),
    ]),
  ),
);
const agentsById = computed(
  () => new Map(agents.value.map((agent) => [agent.agentId, agent])),
);
// Active work first; the order freezes once loaded so rows do not jump while read.
const freshOrder = computed(() =>
  agents.value
    .map((agent) => ({ agent, entry: entries.value[agent.agentId]!, name: agentDisplayName(agent) }))
    .sort(compareWorkbenchRows)
    .map((row) => row.agent.agentId),
);
const stableOrder = useStableOrder(freshOrder, computed(() => !busy.value), space);
const visibleIn = (ids: string[]) =>
  ids.map((id) => agentsById.value.get(id)!).filter((agent) => agent && matches(agent));
const sort = ref<DirectorySort>(initialFilters.sort);
const sortOptions = computed(() => [
  { value: "recent" as const, label: t("agentProfiles.sort.recent") },
  { value: "name" as const, label: t("agentProfiles.sort.name") },
]);
// Recent work keeps the frozen order; by name is a plain alphabetical list.
const visible = computed(() => {
  const rows = visibleIn(stableOrder.order.value);
  return sort.value === "name"
    ? [...rows].sort((a, b) => agentDisplayName(a).localeCompare(agentDisplayName(b), currentLocale()))
    : rows;
});
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
async function openSearch() {
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.focus();
}
const viewOptions = computed(() => [
  { value: "agents" as const, label: t("agentRedesign.projectView.agents") },
  { value: "projects" as const, label: t("agentRedesign.projectView.projects") },
]);
const projectGroups = computed(() =>
  groupAgentsByProject(
    visible.value.map((agent) => agent.agentId),
    (agentId) => profileProjectIds(agentsById.value.get(agentId)!),
    (agentId) => entries.value[agentId]?.status,
    projects.value.map((project) => project.project_id),
    selectedProjects.value,
    { includeEmpty: !search.value.trim() },
  ).map((group) => ({
    ...group,
    key: group.projectId,
    name: projectNames.value[group.projectId] || group.projectId,
    purpose: projectById.value.get(group.projectId)?.profile.purpose ?? null,
    agents: group.agentIds.map((id) => agentsById.value.get(id)!),
  })),
);
const cardProps = (agent: (typeof agents.value)[number]) => ({
  agent,
  spaceId: space.value,
  projectNames: projectNames.value,
  managesAllProjects: managesAllProjects(agent.agentId),
  entry: entries.value[agent.agentId],
  pinned: pinnedAgentIds.value.includes(agent.agentId),
  pinPending: pinSavingAgentId.value === agent.agentId,
  selected: peekId.value === agent.agentId,
});
const reorderAvailable = computed(() => {
  const fresh = visibleIn(freshOrder.value);
  return fresh.some((agent, index) => agent.agentId !== visible.value[index]?.agentId);
});

async function toggleAgentPin(agentId: string, pinned: boolean) {
  await agentPins.setPinned(agentId, pinned);
}

onMounted(() => {
  if (store.runtimeStatus === "idle") void store.refresh();
});

// Keep filters in the URL so Back and shared links return to the same view.
const currentFilters = () => ({
  search: search.value,
  projects: selectedProjects.value,
  status: status.value as DirectoryStatus,
  view: view.value,
  sort: sort.value,
});
watch(() => route.query, (query) => {
  const filters = readDirectoryFilters(query);
  search.value = filters.search;
  selectedProjects.value = filters.projects;
  status.value = filters.status;
  view.value = filters.view;
  sort.value = filters.sort;
});
// This only updates local navigation state; delaying it loses filters on a
// quick visit to a profile followed by Back.
watch([search, status, selectedProjects, view, sort], () => {
  if (sameDirectoryFilters(readDirectoryFilters(route.query), currentFilters())) return;
  void router.replace({ query: directoryFilterQuery(route.query, currentFilters()) });
}, { deep: true });
useScrollRestoration(scroller, "agents-directory", computed(() => visible.value.length > 0));
const focusReturn = useFocusReturn(scroller, "agents-directory", computed(() => visible.value.length > 0));

// Quick look (Peek): ?item=<space>/<agent>. A direct link or a refresh opens
// it before (or without) the roster: an Agent the roster has not read yet is
// read on its own. Another space's Agent is never shown here.
const peek = useRoutePeek();
const peekId = computed(() => (peek.item.value?.spaceId === space.value ? peek.item.value.id : ""));
const peekRecords = useAgentRecords(space, computed(() =>
  peekId.value && !agentsById.value.has(peekId.value) ? [peekId.value] : []));
const peekAgent = computed(() =>
  (peekId.value && (agentsById.value.get(peekId.value) ?? peekRecords.records.value[peekId.value])) || undefined);
const peekEntry = computed(() => {
  const agent = peekAgent.value;
  if (!agent) return undefined;
  return entries.value[agent.agentId] ?? agentWorkbenchEntry(agent, {
    summary: workSummaries.value[agent.agentId],
    summaryState: workState.value,
    tasks: workTasks.value,
  });
});
const peekState = computed(() => {
  const item = peek.item.value;
  if (!item || !space.value) return store.runtimeStatus === "error" ? "error" : "loading";
  if (item.spaceId !== space.value) return "unavailable";
  if (peekAgent.value) return "ready";
  if (peekRecords.loading.value) return "loading";
  return peekRecords.error.value ? "error" : "unavailable";
});
// Focus goes back to what opened the Peek, or to the card for a direct link.
let peekOpener: HTMLElement | null = null;
let lastPeekId = "";
watch(peekId, (id) => { if (id) lastPeekId = id; }, { immediate: true });
function openPeek(agentId: string) {
  const active = document.activeElement;
  peekOpener = active instanceof HTMLElement && active !== document.body ? active : null;
  peek.open({ spaceId: space.value, id: agentId });
}
// Opening lands on the main action (open the full page), so Enter goes on and Esc goes back.
function focusPeekAction(event: Event) {
  const action = (event.target as HTMLElement | null)?.querySelector<HTMLElement>("[data-peek-open-full]");
  if (!action) return;
  event.preventDefault();
  action.focus();
}
function peekOpenChange(open: boolean) {
  if (!open) peek.close();
}
function returnFocusFromPeek(event: Event) {
  event.preventDefault();
  const opener = peekOpener;
  peekOpener = null;
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  else focusReturnTarget(scroller.value, lastPeekId);
}
// The full page replaces the Peek in history, so Back returns to the
// collection (filters, scroll and focus on this card), not to the Peek.
function openFullPage() {
  const agent = peekAgent.value;
  if (!agent) return;
  focusReturn.remember(agent.agentId);
  void router.replace(agentProfilePath(space.value, agent.agentId));
}

watch(
  [space, () => route.query.agent],
  ([spaceId, agent]) => {
    if (spaceId && typeof agent === "string") {
      const { agent: _legacy, ...query } = route.query;
      void router.replace({
        path:
          typeof route.query.task === "string"
            ? "/project-agents/manage"
            : agentProfilePath(spaceId, agent),
        query: typeof route.query.task === "string" ? route.query : query,
      });
    }
  },
  { immediate: true },
);

watch(space, (_current, previous) => {
  if (!previous) return;
  search.value = "";
  selectedProjects.value = [];
  status.value = "all";
  openProjects.value = {};
});

async function recruited(result: EmployeeRecruitmentResult) {
  recruiting.value = false;
  await router.push(agentProfilePath(space.value, result.agent.agentId));
}

// Reading on toward the end of the list asks for the next page; a failed
// page waits for the reader's retry instead of looping.
watch([nearEnd, pageLoading, pageError, rosterComplete], () => {
  if (nearEnd.value && !pageLoading.value && !pageError.value && !rosterComplete.value)
    void loadMore();
});

async function retryDirectory() {
  if (!store.state) await store.refresh();
  await Promise.allSettled([reload(), loadWorkSummary()]);
}

function handleProjectCreated(project: PersonalProject) {
  store.rememberPersonalProject(project);
}
</script>

<template>
  <section
    ref="scroller"
    class="view agents-directory"
    :aria-label="t('agentProfiles.title')"
  >
    <div class="@container mx-auto w-full max-w-(--canvas-max)">
      <!-- One toolbar: filters first, then the count and the actions. It stays
           in reach on tall screens and scrolls away on short ones. -->
      <div class="agents-directory-toolbar">
        <div class="ui-toolbar agents-directory-filters">
          <UiSelect
            v-model="selectedProjects"
            class="agents-directory-select"
            multiple
            :options="options"
            :label="t('employees.filterLabel')"
            :placeholder="t('employees.allProjectsFilter')"
          />
          <UiSelect
            v-model="status"
            class="agents-directory-select"
            :options="statusOptions"
            :label="t('projectAgents.fields.status')"
          />
          <UiSelect
            v-model="sort"
            class="agents-directory-select"
            data-directory-sort
            :options="sortOptions"
            :label="t('agentProfiles.sort.label')"
          />
          <UiSegmented
            v-model="view"
            class="agents-directory-view"
            data-directory-view
            :options="viewOptions"
            :label="t('agentRedesign.projectView.label')"
          />
          <!-- Search stays one icon until it is needed or holds a query. -->
          <label v-if="searchOpen || search" class="agents-directory-search">
            <span class="ui-sr-only">{{ t("agentProfiles.search") }}</span>
            <input
              ref="searchInput"
              v-model="search"
              type="search"
              maxlength="160"
              :placeholder="t('agentProfiles.search')"
              @focus="searchOpen = true"
              @blur="searchOpen = false"
              @keydown.esc="search = ''; searchOpen = false"
            />
          </label>
          <UiIconButton v-else icon="search" :label="t('agentProfiles.search')" data-directory-search @click="openSearch" />
        </div>
        <div class="agents-directory-heading">
          <GrowthLoading
            v-if="busy && agents.length"
            variant="inline"
            :label="t('agentRedesign.refreshing')"
          />
          <p v-if="!busy || agents.length" class="agents-directory-count">
            {{ t(partialRoster ? "agentProfiles.membersLoaded" : "agentProfiles.members", { count: agents.length }) }}
          </p>
          <EmployeeWorkbenchLinks :personal-space-id="space || 'current'" />
          <Button
            v-if="hireable"
            size="sm"
            :disabled="!space"
            @click="recruiting = true"
          >
            {{ t("employees.recruit") }}
          </Button>
        </div>
      </div>

      <p v-if="pinError" class="agents-directory-notice is-error" role="alert">
        <span>{{ pinError }}</span>
        <Button size="sm" variant="ghost" @click="agentPins.load({ force: true })">
          {{ pinRetryLabel }}
        </Button>
      </p>
      <ProjectAgentFirstTask
        v-if="!busy && !pageError && store.runtimeStatus === 'ready' && !projects.length"
        :personal-space-id="space"
      />

      <p v-if="workError" class="agents-directory-notice agent-directory-work-error" role="status">
        <span>{{ t("agentRedesign.workStatus.refreshError") }}</span>
        <Button size="sm" variant="ghost" @click="loadWorkSummary">
          {{ t("agentProfiles.retry") }}
        </Button>
      </p>

      <GrowthLoading
        v-if="busy && !agents.length"
        :label="t('agentProfiles.loading')"
      />
      <div
        v-if="(pageError && !agents.length) || store.runtimeStatus === 'error'"
        v-show="!busy || agents.length === 0"
        role="alert"
        class="ui-card ui-empty agent-profile-empty"
      >
        <p>{{ (!agents.length && pageError) || t("agentProfiles.loadError") }}</p>
        <Button size="sm" variant="outline" @click="retryDirectory">
          {{ t("agentProfiles.retry") }}
        </Button>
      </div>
      <p v-if="partialRoster" class="agents-directory-partial" role="status">
        {{ t(filtering ? "agentProfiles.partialFilter" : "agentProfiles.partialRoster", { count: agents.length }) }}
      </p>
      <p
        v-if="
          !busy &&
          rosterComplete &&
          !visible.length &&
          view === 'agents' &&
          !pageError &&
          store.runtimeStatus !== 'error'
        "
        class="ui-card ui-empty agent-profile-empty"
      >
        {{
          t(agents.length ? "agentProfiles.noMatch" : "agentProfiles.noAgents")
        }}
      </p>
      <p v-if="reorderAvailable && !busy" class="agents-directory-reorder" role="status">
        <span>{{ t("agentRedesign.workbench.reorderHint") }}</span>
        <Button size="sm" variant="ghost" data-workbench-reorder @click="stableOrder.apply()">
          {{ t("agentRedesign.workbench.reorder") }}
        </Button>
      </p>
      <!-- 1/2/3/4 columns by the canvas width: a wide screen adds columns
           instead of stretching a card. -->
      <ul v-if="visible.length && view === 'agents'" class="agents-directory-grid grid grid-cols-1 gap-3 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4">
        <li v-for="agent in visible" :key="agent.agentId">
          <AgentCard v-bind="cardProps(agent)" @toggle-pin="toggleAgentPin(agent.agentId, $event)" @peek="openPeek(agent.agentId)" />
        </li>
      </ul>
      <div v-else-if="view === 'projects'" class="agents-directory-projects">
        <UnassignedConversationsPanel
          :space-id="space"
          :formal-projects="projects"
          :existing-project-ids="allSpaceProjects.map((project) => project.project_id)"
          @project-created="handleProjectCreated"
        />
        <DirectoryProjectGroup
          v-for="group in projectGroups"
          :key="group.key"
          v-model:expanded="openProjects[group.key]"
          :space-id="space"
          :project-id="group.projectId"
          :name="group.name"
          :purpose="group.purpose"
          :agents="group.agents"
          :count="group.agents.length"
          :running-count="group.runningCount"
          :unknown-count="group.unknownCount"
        >
          <ul class="agents-directory-grid grid grid-cols-1 gap-3 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4">
            <li v-for="agent in group.agents" :key="agent.agentId">
              <AgentCard v-bind="cardProps(agent)" @toggle-pin="toggleAgentPin(agent.agentId, $event)" @peek="openPeek(agent.agentId)" />
            </li>
          </ul>
        </DirectoryProjectGroup>
      </div>

      <div v-if="agents.length && !rosterComplete" ref="rosterEnd" class="agents-directory-more">
        <GrowthLoading v-if="pageLoading" variant="inline" :label="t('agentProfiles.loadingMore')" />
        <p v-else-if="pageError" class="agents-directory-more-error" role="alert">
          <span>{{ t("agentProfiles.loadMoreError") }} {{ pageError }}</span>
          <Button size="sm" variant="ghost" data-roster-retry @click="loadMore">
            {{ t("agentProfiles.retry") }}
          </Button>
        </p>
        <Button size="sm" variant="ghost" v-else data-roster-more @click="loadMore">
          {{ t("agentProfiles.loadMore") }}
        </Button>
      </div>
    </div>

    <BackToTop :scroller="scroller" />

    <Dialog :open="Boolean(peek.item.value)" @update:open="peekOpenChange">
      <DialogContent class="agent-peek" data-agent-peek-dialog @open-auto-focus="focusPeekAction" @close-auto-focus="returnFocusFromPeek">
        <AgentPeek
          :state="peekState"
          :error="peekRecords.error.value"
          :agent="peekAgent"
          :entry="peekEntry"
          :project-names="projectNames"
          :manages-all-projects="peekAgent ? managesAllProjects(peekAgent.agentId) : false"
          :pinned="peekAgent ? pinnedAgentIds.includes(peekAgent.agentId) : false"
          :pin-pending="Boolean(peekAgent) && pinSavingAgentId === peekAgent?.agentId"
          @toggle-pin="peekAgent && toggleAgentPin(peekAgent.agentId, $event)"
          @open-full="openFullPage"
          @retry="peekRecords.load({ force: true })"
        />
      </DialogContent>
    </Dialog>

    <EmployeeRecruitDialog
      :open="recruiting"
      :personal-space-id="space"
      :projects="projects"
      :default-project-ids="selectedProjects ?? []"
      @close="recruiting = false"
      @recruited="recruited"
    />
  </section>
</template>

<style src="@/features/agent-profile/agent-profile.css" />

<style scoped>
.agents-directory { scrollbar-gutter: stable; }
.agents-directory-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px;
  padding-block: 4px 16px; background: var(--color-bg);
}
/* Tall screens keep the filters in reach while reading a long roster; short
   ones give that height back to the cards. */
@media (min-height: 820px) {
  .agents-directory-toolbar { position: sticky; top: -12px; z-index: 2; padding-top: 16px; margin-top: -12px; }
}
.agents-directory-notice {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin: 0 0 16px; padding: 8px 12px; border-radius: var(--radius-control); background: var(--color-surface);
  color: var(--color-muted); font-size: 13px;
}
.agents-directory-notice.is-error { color: var(--color-danger); }
</style>
