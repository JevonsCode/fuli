<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import GrowthLoading from "@/components/GrowthLoading.vue";
import AgentCard from "@/features/agent-profile/AgentCard.vue";
import {
  agentDisplayName,
  agentProfilePath,
  fuzzyMatch,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import { useAgentRoster } from "@/features/agent-profile/useAgentRoster";
import ProjectAgentFirstTask from "@/features/project-agents/ProjectAgentFirstTask.vue";
import { useAgentWorkSummary } from "@/features/agent-profile/useAgentWorkSummary";
import UiSelect from "@/components/ui/UiSelect.vue";
import EmployeeRecruitDialog from "@/features/employees/EmployeeRecruitDialog.vue";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
import type { EmployeeRecruitmentResult } from "@/features/employees/catalog";

const store = useConsoleStore();
const route = useRoute();
const router = useRouter();
const space = computed(() => store.activePersonalSpace?.id ?? "");
const { agents, loading, error, load } = useAgentRoster(space);
const {
  summaries: workSummaries,
  loading: workLoading,
  error: workError,
  state: workState,
  load: loadWorkSummary,
} = useAgentWorkSummary(space);
const search = ref(typeof route.query.q === "string" ? route.query.q : "");
const status = ref("all");
// No selected project means every project.
const selectedProjects = ref<string[]>(
  typeof route.query.project === "string" ? [route.query.project] : [],
);
const recruiting = ref(false);

const projects = computed(() =>
  (store.state?.personalProjects ?? []).filter(
    (project) => project.personal_space_id === space.value,
  ),
);
const options = computed(() =>
  projects.value.map((project) => ({ value: project.project_id, label: project.profile.name })),
);
const projectNames = computed<Record<string, string>>(() =>
  Object.fromEntries(options.value.map((project) => [project.value, project.label])),
);
const statusOptions = computed(() => [
  { value: "all", label: t("agentProfiles.allStatus") },
  ...["active", "inactive", "archived"].map((value) => ({ value, label: t(`projectAgents.status.${value}`) })),
]);

const visible = computed(() =>
  agents.value
    .filter(
      (agent) =>
        (status.value === "all" || agent.profile.status === status.value) &&
        (!selectedProjects.value.length ||
          profileProjectIds(agent).some((id) =>
            selectedProjects.value.includes(id),
          )) &&
        fuzzyMatch(
          [
            agentDisplayName(agent),
            agent.profile.responsibility,
            ...agent.profile.capabilities,
            ...profileProjectIds(agent).map((id) => projectNames.value[id] || id),
          ].join(" "),
          search.value,
        ),
    )
    .sort((a, b) => agentDisplayName(a).localeCompare(agentDisplayName(b))),
);
const busy = computed(
  () =>
    loading.value ||
    workLoading.value ||
    store.runtimeStatus === "loading",
);
const workSummaryFor = (agentId: string) => workSummaries.value[agentId];

onMounted(() => {
  if (store.runtimeStatus === "idle") void store.refresh();
});

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
});

async function recruited(result: EmployeeRecruitmentResult) {
  recruiting.value = false;
  await router.push(agentProfilePath(space.value, result.agent.agentId));
}

async function retryDirectory() {
  if (store.state) {
    await Promise.allSettled([load(), loadWorkSummary()]);
    return;
  }
  await store.refresh();
  await Promise.allSettled([load(), loadWorkSummary()]);
}
</script>

<template>
  <section
    class="view agents-directory"
    :aria-label="t('agentProfiles.title')"
  >
    <header class="ui-toolbar agents-directory-heading">
      <p v-if="!busy || agents.length" class="agents-directory-count">
        {{ t("agentProfiles.members", { count: agents.length }) }}
      </p>
      <span v-else class="agents-directory-count" aria-hidden="true">&nbsp;</span>
      <div class="agent-profile-actions">
        <GrowthLoading
          v-if="busy && agents.length"
          variant="inline"
          :label="t('agentRedesign.refreshing')"
        />
        <RouterLink class="quiet-button" to="/employees/bole">
          {{ t("agentProfiles.hr") }}
        </RouterLink>
        <button
          type="button"
          class="primary-button"
          :disabled="!space"
          @click="recruiting = true"
        >
          {{ t("employees.recruit") }}
        </button>
      </div>
    </header>
    <ProjectAgentFirstTask
      v-if="!busy && !error && store.runtimeStatus === 'ready' && !projects.length"
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
        <span class="sr-only">{{ t("agentProfiles.search") }}</span>
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
    </div>

    <GrowthLoading
      v-if="busy && !agents.length"
      :label="t('agentProfiles.loading')"
    />
    <div
      v-if="error || store.runtimeStatus === 'error'"
      v-show="!busy || agents.length === 0"
      role="alert"
      class="ui-card ui-empty agent-profile-empty"
    >
      <p>{{ error || t("agentProfiles.loadError") }}</p>
      <button class="quiet-button" type="button" @click="retryDirectory">
        {{ t("agentProfiles.retry") }}
      </button>
    </div>
    <p
      v-if="
        !busy &&
        !visible.length &&
        !error &&
        store.runtimeStatus !== 'error'
      "
      class="ui-card ui-empty agent-profile-empty"
    >
      {{
        t(agents.length ? "agentProfiles.noMatch" : "agentProfiles.noAgents")
      }}
    </p>
    <ul v-if="visible.length" class="agents-directory-grid">
      <li v-for="agent in visible" :key="agent.agentId">
        <AgentCard
          :agent="agent"
          :space-id="space"
          :project-names="projectNames"
          :work-summary="workSummaryFor(agent.agentId)"
          :work-state="workState"
        />
      </li>
    </ul>

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
