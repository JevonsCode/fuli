<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import GrowthLoading from "@/components/GrowthLoading.vue";
import AgentName from "@/features/agent-profile/AgentName.vue";
import {
  agentDisplayName,
  agentProfilePath,
  fuzzyMatch,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import { useAgentRoster } from "@/features/agent-profile/useAgentRoster";
import AgentHand from "@/features/project-agents/AgentHand.vue";
import ProjectScopePicker from "@/features/employees/ProjectScopePicker.vue";
import EmployeeRecruitDialog from "@/features/employees/EmployeeRecruitDialog.vue";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
import type { EmployeeRecruitmentResult } from "@/features/employees/catalog";
const store = useConsoleStore();
const route = useRoute();
const router = useRouter();
const space = computed(() => store.activePersonalSpace?.id ?? "");
const { agents, loading, error, load } = useAgentRoster(space);
const search = ref(typeof route.query.q === "string" ? route.query.q : "");
const status = ref("all");
const selectedProjects = ref<string[] | null>(
  typeof route.query.project === "string" ? [route.query.project] : null,
);
const recruiting = ref(false);
const projects = computed(() =>
  (store.state?.personalProjects ?? []).filter(
    (project) => project.personal_space_id === space.value,
  ),
);
const options = computed(() =>
  projects.value.map((p) => ({ id: p.project_id, name: p.profile.name })),
);
const projectSelection = computed({
  get: () => selectedProjects.value ?? options.value.map((p) => p.id),
  set: (value: string[]) => {
    selectedProjects.value =
      value.length === options.value.length ? null : value;
  },
});
const names = computed(() => new Map(options.value.map((p) => [p.id, p.name])));
const visible = computed(() =>
  agents.value
    .filter(
      (agent) =>
        (status.value === "all" || agent.profile.status === status.value) &&
        (selectedProjects.value === null ||
          profileProjectIds(agent).some((id) =>
            selectedProjects.value!.includes(id),
          )) &&
        fuzzyMatch(
          [
            agentDisplayName(agent),
            agent.profile.responsibility,
            ...agent.profile.capabilities,
            ...profileProjectIds(agent).map((id) => names.value.get(id) || id),
          ].join(" "),
          search.value,
        ),
    )
    .sort((a, b) => agentDisplayName(a).localeCompare(agentDisplayName(b))),
);
const busy = computed(() => loading.value || store.runtimeStatus === "loading");
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
  selectedProjects.value = null;
  status.value = "all";
});
async function recruited(result: EmployeeRecruitmentResult) {
  recruiting.value = false;
  await router.push(agentProfilePath(space.value, result.agent.agentId));
}
</script>
<template>
  <section class="view agents-directory">
    <header class="agents-directory-heading">
      <div>
        <h2>{{ t("agentProfiles.title") }}</h2>
        <p v-if="!busy">
          {{ t("agentProfiles.members", { count: agents.length }) }}
        </p>
      </div>
      <div class="agent-profile-actions">
        <RouterLink class="quiet-button" to="/employees/bole">{{
          t("agentProfiles.hr")
        }}</RouterLink
        ><button
          type="button"
          class="primary-button"
          :disabled="!space"
          @click="recruiting = true"
        >
          {{ t("employees.recruit") }}
        </button>
      </div>
    </header>
    <div class="agents-directory-filters">
      <label class="agents-directory-search"
        ><span class="sr-only">{{ t("agentProfiles.search") }}</span
        ><input
          v-model="search"
          type="search"
          maxlength="160"
          :placeholder="t('agentProfiles.search')"
      /></label>
      <ProjectScopePicker
        v-model="projectSelection"
        :projects="options"
        :label="t('employees.filterLabel')"
        :empty-label="t('employees.filterEmpty')"
        compact
        hint=""
      />
      <select v-model="status" :aria-label="t('projectAgents.fields.status')">
        <option value="all">{{ t("agentProfiles.allStatus") }}</option>
        <option
          v-for="value in ['active', 'inactive', 'archived']"
          :key="value"
          :value="value"
        >
          {{ t(`projectAgents.status.${value}`) }}
        </option>
      </select>
    </div>
    <GrowthLoading v-if="busy" :label="t('agentProfiles.loading')" />
    <div
      v-else-if="error || store.runtimeStatus === 'error'"
      role="alert"
      class="agent-profile-empty"
    >
      <p>{{ error || t("agentProfiles.loadError") }}</p>
      <button
        class="quiet-button"
        @click="store.state ? load() : store.refresh()"
      >
        {{ t("agentProfiles.retry") }}
      </button>
    </div>
    <p v-else-if="!visible.length" class="agent-profile-empty">
      {{
        t(agents.length ? "agentProfiles.noMatch" : "agentProfiles.noAgents")
      }}
    </p>
    <ul v-else class="agents-directory-list">
      <li v-for="agent in visible" :key="agent.agentId">
        <span class="agent-portrait small" aria-hidden="true">{{
          agent.profile.occupationEmoji || agentDisplayName(agent).slice(0, 1)
        }}</span>
        <div class="agent-directory-person">
          <div class="agent-directory-name">
            <AgentName
              :space-id="space"
              :agent-id="agent.agentId"
              :name="agentDisplayName(agent)"
            /><AgentHand :agent-id="agent.agentId" />
          </div>
          <p>{{ agent.profile.responsibility }}</p>
          <div class="agent-inline-skills">
            <span
              v-for="skill in agent.profile.capabilities.slice(0, 3)"
              :key="skill"
              >{{ skill }}</span
            >
          </div>
        </div>
        <div class="agent-directory-projects">
          <span v-for="id in profileProjectIds(agent).slice(0, 2)" :key="id">{{
            names.get(id) || id
          }}</span
          ><span v-if="!profileProjectIds(agent).length">{{
            t("agentProfiles.noProject")
          }}</span>
        </div>
        <span class="agent-directory-status">{{
          t(`projectAgents.status.${agent.profile.status}`)
        }}</span>
        <RouterLink
          class="agent-directory-open"
          :to="agentProfilePath(space, agent.agentId)"
          :aria-label="`${agentDisplayName(agent)} · ${t('agentProfiles.profile')}`"
          ><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path
              d="m7 4 6 6-6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            /></svg
        ></RouterLink>
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
