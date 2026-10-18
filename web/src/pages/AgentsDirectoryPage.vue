<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import BackToTop from "@/components/BackToTop.vue";
import GrowthLoading from "@/components/GrowthLoading.vue";
import { useNearEnd } from "@/composables/useNearEnd";
import { useScrollRestoration } from "@/composables/useScrollRestoration";
import {
  directoryFilterQuery,
  readDirectoryFilters,
  sameDirectoryFilters,
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
import EmployeeRecruitDialog from "@/features/employees/EmployeeRecruitDialog.vue";
import EmployeeWorkbenchLinks from "@/features/employees/EmployeeWorkbenchLinks.vue";
import { employeeTemplates } from "@/features/employees/catalog";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
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
const visible = computed(() => visibleIn(stableOrder.order.value));
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
});
watch(() => route.query, (query) => {
  const filters = readDirectoryFilters(query);
  search.value = filters.search;
  selectedProjects.value = filters.projects;
  status.value = filters.status;
  view.value = filters.view;
});
// This only updates local navigation state; delaying it loses filters on a
// quick visit to a profile followed by Back.
watch([search, status, selectedProjects, view], () => {
  if (sameDirectoryFilters(readDirectoryFilters(route.query), currentFilters())) return;
  void router.replace({ query: directoryFilterQuery(route.query, currentFilters()) });
}, { deep: true });
useScrollRestoration(scroller, "agents-directory", computed(() => visible.value.length > 0));

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
  if (!store.state) return;
  const current = store.state.personalProjects ?? [];
  if (!current.some((item) => item.project_id === project.project_id)) {
    store.state.personalProjects = [...current, project];
  }
}
</script>

<template>
  <section
    ref="scroller"
    class="view agents-directory"
    :aria-label="t('agentProfiles.title')"
  >
    <header class="ui-toolbar agents-directory-heading">
      <p v-if="!busy || agents.length" class="agents-directory-count">
        {{ t(partialRoster ? "agentProfiles.membersLoaded" : "agentProfiles.members", { count: agents.length }) }}
      </p>
      <span v-else class="agents-directory-count" aria-hidden="true">&nbsp;</span>
      <div class="agent-profile-actions">
        <GrowthLoading
          v-if="busy && agents.length"
          variant="inline"
          :label="t('agentRedesign.refreshing')"
        />
        <EmployeeWorkbenchLinks :personal-space-id="space || 'current'" />
        <button
          v-if="hireable"
          type="button"
          class="primary-button"
          :disabled="!space"
          @click="recruiting = true"
        >
          {{ t("employees.recruit") }}
        </button>
      </div>
    </header>
    <p v-if="pinError" class="agent-directory-pin-error" role="alert">
      <span>{{ pinError }}</span>
      <button class="quiet-button" type="button" @click="agentPins.load({ force: true })">
        {{ pinRetryLabel }}
      </button>
    </p>
    <ProjectAgentFirstTask
      v-if="!busy && !pageError && store.runtimeStatus === 'ready' && !projects.length"
      :personal-space-id="space"
    />

    <p v-if="workError" class="agent-directory-work-error" role="status">
      <span>{{ t("agentRedesign.workStatus.refreshError") }}</span>
      <button class="quiet-button" type="button" @click="loadWorkSummary">
        {{ t("agentProfiles.retry") }}
      </button>
    </p>

    <div class="ui-toolbar agents-directory-filters">
      <label class="agents-directory-search">
        <span class="ui-sr-only">{{ t("agentProfiles.search") }}</span>
        <input
          v-model="search"
          type="search"
          maxlength="160"
          :placeholder="t('agentProfiles.search')"
        />
      </label>
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
      <UiSegmented
        v-model="view"
        class="agents-directory-view"
        data-directory-view
        :options="viewOptions"
        :label="t('agentRedesign.projectView.label')"
      />
    </div>

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
      <button class="quiet-button" type="button" @click="retryDirectory">
        {{ t("agentProfiles.retry") }}
      </button>
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
      <button class="quiet-button" type="button" data-workbench-reorder @click="stableOrder.apply()">
        {{ t("agentRedesign.workbench.reorder") }}
      </button>
    </p>
    <ul v-if="visible.length && view === 'agents'" class="agents-directory-grid">
      <li v-for="agent in visible" :key="agent.agentId">
        <AgentCard v-bind="cardProps(agent)" @toggle-pin="toggleAgentPin(agent.agentId, $event)" />
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
        <ul class="agents-directory-grid">
          <li v-for="agent in group.agents" :key="agent.agentId">
            <AgentCard v-bind="cardProps(agent)" @toggle-pin="toggleAgentPin(agent.agentId, $event)" />
          </li>
        </ul>
      </DirectoryProjectGroup>
    </div>

    <div v-if="agents.length && !rosterComplete" ref="rosterEnd" class="agents-directory-more">
      <GrowthLoading v-if="pageLoading" variant="inline" :label="t('agentProfiles.loadingMore')" />
      <p v-else-if="pageError" class="agents-directory-more-error" role="alert">
        <span>{{ t("agentProfiles.loadMoreError") }} {{ pageError }}</span>
        <button class="quiet-button" type="button" data-roster-retry @click="loadMore">
          {{ t("agentProfiles.retry") }}
        </button>
      </p>
      <button v-else class="quiet-button" type="button" data-roster-more @click="loadMore">
        {{ t("agentProfiles.loadMore") }}
      </button>
    </div>

    <BackToTop :scroller="scroller" />

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
.agent-directory-pin-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  margin: calc(var(--space-6, 24px) * -1) 0 var(--space-4, 16px);
  color: var(--color-danger);
  font-size: 13px;
}

.agent-directory-pin-error .quiet-button {
  min-height: var(--control-height-sm);
  padding: 4px 9px;
  font-size: 12px;
}
</style>
