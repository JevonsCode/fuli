<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { getJson } from "@/api/client";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
import GrowthLoading from "@/components/GrowthLoading.vue";
import UiDisclosure from "@/components/UiDisclosure.vue";
import AgentName from "@/features/agent-profile/AgentName.vue";
import AgentProfileSettings from "@/features/agent-profile/AgentProfileSettings.vue";
import AgentConversations from "@/features/project-agents/AgentConversations.vue";
import {
  agentDisplayName,
  collaboratorsFor,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import { isAgentTaskDataComplete, taskHasAgent } from "@/features/agent-profile/agent-work-summary";
import { useAgentRoster } from "@/features/agent-profile/useAgentRoster";
import { CURRENT_WORK_STATUSES } from "@/features/overview/overview-data";
import {
  arrayOf,
  normalizeAssignment,
  normalizeTask,
  unknownRecord,
} from "@/features/project-agents/task-evidence";
import { employeeTemplates, refreshEmployeeCatalog } from "@/features/employees/catalog";
import type {
  ProjectAgentAssignmentRecord,
  ProjectAgentCoordinationPolicy,
  ProjectAgentRecord,
  ProjectAgentTaskRecord,
} from "@/types";
import { personalProjectsPath } from "@/router/paths";

type ProfileTab =
  | "overview"
  | "history"
  | "style"
  | "collaborators"
  | "conversations"
  | "management";

const route = useRoute();
const store = useConsoleStore();
const space = computed(() => store.activePersonalSpace?.id ?? "");
const { agents, loading, error, load } = useAgentRoster(space);
const agent = computed(() =>
  route.params.spaceId === space.value
    ? agents.value.find(
        (item) =>
          item.personalSpaceId === space.value &&
          (item.agentId === route.params.agentId ||
            item.legacyAgentIds?.includes(String(route.params.agentId))),
      )
    : undefined,
);
const projects = computed(() =>
  (store.state?.personalProjects ?? []).filter(
    (item) => item.personal_space_id === space.value,
  ),
);
const employeeProjects = computed(() =>
  projects.value.map((item) => ({ id: item.project_id, name: item.profile.name })),
);
const projectName = (id: string) =>
  projects.value.find((item) => item.project_id === id)?.profile.name || id;
const personName = (id: string) => {
  const person = agents.value.find((item) => item.agentId === id);
  return person ? agentDisplayName(person) : id;
};

const tasks = ref<ProjectAgentTaskRecord[]>([]);
const assignments = ref<ProjectAgentAssignmentRecord[] | undefined>(undefined);
const teams = ref<
  Array<{
    projectId: string;
    policy: ProjectAgentCoordinationPolicy | null;
    error: boolean;
  }>
>([]);
const detailsLoading = ref(false);
const partial = ref(false);
const showSettings = ref(false);
const activeTab = ref<ProfileTab>("overview");

const profileTabs = computed(() => {
  const tabs: Array<{ id: ProfileTab; label: string }> = [
    { id: "overview", label: t("agentProfiles.working") },
    { id: "history", label: t("agentProfiles.experience") },
    { id: "style", label: t("agentProfiles.about") },
    { id: "collaborators", label: t("agentProfiles.collaborators") },
    { id: "management", label: t("agentProfiles.advanced") },
  ];
  if (agent.value?.memoryScope === "reviewed_agent") {
    tabs.splice(4, 0, {
      id: "conversations",
      label: t("projectAgents.conversations.title"),
    });
  }
  return tabs;
});
const collaborators = computed(() =>
  agent.value ? collaboratorsFor(agent.value.agentId, tasks.value) : [],
);
const currentProjects = computed(() =>
  agent.value
    ? profileProjectIds({
        ...agent.value,
        assignments: assignments.value ?? agent.value.assignments,
      })
    : [],
);
const visibleCurrentProjects = computed(() => currentProjects.value.slice(0, 4));
const remainingCurrentProjects = computed(() => currentProjects.value.slice(4));
const previousProjects = computed(() =>
  (assignments.value ?? []).filter((item) => item.status !== "active"),
);
const currentWork = computed(() =>
  tasks.value
    .filter((task) => CURRENT_WORK_STATUSES.has(task.status))
    .slice(0, 6),
);
const workbench = computed(() =>
  employeeTemplates.value.find((item) => item.agentId === agent.value?.agentId),
);
const date = (value?: string | null) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleDateString()
    : t("agentProfiles.timeUnknown");
const projectResponsibility = (projectId: string) => {
  const responsibility = assignments.value
    ?.find(
      (item) =>
        item.personalProjectId === projectId && item.status === "active",
    )
    ?.responsibility?.trim();
  const profileResponsibility = agent.value?.profile.responsibility.trim();
  return responsibility && responsibility !== profileResponsibility
    ? responsibility
    : "";
};
const projectOverflowLabel = computed(() => {
  const key = "agentRedesign.projects.more";
  const translated = t(key, { count: currentProjects.value.length });
  return translated === key
    ? `All projects (${currentProjects.value.length})`
    : translated;
});

let generation = 0;
watch(
  () =>
    agent.value ? `${agent.value.personalSpaceId}/${agent.value.agentId}` : "",
  async () => {
    const person = agent.value;
    const current = ++generation;
    tasks.value = [];
    assignments.value = undefined;
    teams.value = [];
    partial.value = false;
    detailsLoading.value = false;
    showSettings.value = false;
    activeTab.value = "overview";
    if (!person) return;
    void refreshEmployeeCatalog(person.personalSpaceId);
    detailsLoading.value = true;
    assignments.value = person.assignments;
    const params = new URLSearchParams({
      personalSpaceId: person.personalSpaceId,
    });
    const assignmentParams = new URLSearchParams({
      personalSpaceId: person.personalSpaceId,
      agentId: person.agentId,
    });
    const results = await Promise.allSettled([
      getJson<unknown>(`/api/project-agent-tasks?${params}&limit=200`),
      getJson<unknown>(`/api/project-agent-assignments?${assignmentParams}`),
    ]);
    if (current !== generation) return;
    const [taskResult, assignmentResult] = results;
    if (taskResult.status === "fulfilled") {
      const value = taskResult.value;
      const record = unknownRecord(value);
      partial.value = !isAgentTaskDataComplete(value);
      tasks.value = arrayOf(
        Array.isArray(value) ? value : (record.tasks ?? record.items),
      )
        .map(normalizeTask)
        .filter((item): item is ProjectAgentTaskRecord =>
          Boolean(
            item &&
              (!item.personalSpaceId ||
                item.personalSpaceId === person.personalSpaceId) &&
              taskHasAgent(item, person.agentId),
          ),
        )
        .sort((a, b) =>
          (b.updatedAt ?? b.createdAt ?? "").localeCompare(
            a.updatedAt ?? a.createdAt ?? "",
          ),
        );
    } else partial.value = true;
    if (assignmentResult.status === "fulfilled") {
      const value = assignmentResult.value;
      const record = unknownRecord(value);
      assignments.value = arrayOf(
        Array.isArray(value) ? value : (record.assignments ?? record.items),
      )
        .map((item) => normalizeAssignment(item, person))
        .filter((item): item is ProjectAgentAssignmentRecord =>
          Boolean(
            item &&
              item.agentId === person.agentId &&
              item.personalSpaceId === person.personalSpaceId,
          ),
        );
    } else partial.value = true;
    const ids = profileProjectIds({
      ...person,
      assignments: assignments.value ?? person.assignments,
    });
    const organization = await Promise.all(
      ids.map(async (projectId) => {
        try {
          const policy = await getJson<ProjectAgentCoordinationPolicy>(
            `/api/project-agent-coordination-policy?${new URLSearchParams({ personalSpaceId: person.personalSpaceId, personalProjectId: projectId })}`,
          );
          return { projectId, policy, error: false };
        } catch {
          return { projectId, policy: null, error: true };
        }
      }),
    );
    if (current === generation) {
      teams.value = organization;
      detailsLoading.value = false;
    }
  },
  { immediate: true },
);

function saved(person: ProjectAgentRecord) {
  const index = agents.value.findIndex((item) => item.agentId === person.agentId);
  if (index >= 0) agents.value[index] = { ...agents.value[index], ...person };
}

function selectTab(tab: ProfileTab) {
  activeTab.value = tab;
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  const key = event.key;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
  const source = event.currentTarget as HTMLElement | null;
  event.preventDefault();
  const count = profileTabs.value.length;
  const nextIndex = key === 'Home'
    ? 0
    : key === 'End'
      ? count - 1
      : (index + (key === 'ArrowRight' ? 1 : -1) + count) % count;
  const nextTab = profileTabs.value[nextIndex];
  if (!nextTab) return;
  selectTab(nextTab.id);
  void nextTick(() => {
    const tablist = source?.closest('[role="tablist"]');
    const target = tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex];
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });
}

onMounted(() => {
  if (store.runtimeStatus === "idle") void store.refresh();
});
</script>

<template>
  <section
    class="view agent-profile-page"
    :aria-label="t('agentProfiles.profile')"
  >
    <RouterLink class="agent-profile-back" to="/project-agents">
      ← {{ t("agentProfiles.back") }}
    </RouterLink>

    <GrowthLoading
      v-if="(loading || store.runtimeStatus === 'loading') && !agent"
      :label="t('agentProfiles.loading')"
    />
    <div
      v-else-if="(error || store.runtimeStatus === 'error') && !agent"
      class="ui-card ui-empty agent-profile-empty"
      role="alert"
    >
      <p>{{ error || t("agentProfiles.loadError") }}</p>
      <button class="quiet-button" type="button" @click="store.state ? load() : store.refresh()">
        {{ t("agentProfiles.retry") }}
      </button>
    </div>
    <p v-else-if="!agent" class="ui-card ui-empty agent-profile-empty">
      {{ t("agentProfiles.unavailable") }}
    </p>
    <template v-else>
      <header class="ui-card agent-resume-header">
        <span class="agent-portrait" aria-hidden="true">
          {{ agent.profile.occupationEmoji || agentDisplayName(agent).slice(0, 1) }}
        </span>
        <div class="agent-resume-intro">
          <div class="agent-resume-name-row">
            <h1>{{ agentDisplayName(agent) }}</h1>
            <span v-if="agent.employeeNumber" class="ui-badge fla-employee-number">FLA {{ agent.employeeNumber }}</span>
            <span
              class="ui-badge agent-profile-membership"
              :class="`is-${agent.profile.status}`"
            >
              {{ t(`projectAgents.status.${agent.profile.status}`) }}
            </span>
          </div>
          <p>{{ agent.profile.responsibility }}</p>
          <div class="agent-resume-meta">
            <span>
              {{
                t(
                  agent.recruitedAt
                    ? "agentProfiles.joined"
                    : "agentProfiles.created",
                )
              }}
              · {{ date(agent.recruitedAt || agent.createdAt) }}
            </span>
          </div>
        </div>
        <div class="agent-profile-actions">
          <RouterLink
            v-if="workbench"
            class="quiet-button"
            :to="`/employees/${encodeURIComponent(workbench.id)}`"
          >
            {{ t("agentProfiles.workbench") }}
          </RouterLink>
          <button
            class="quiet-button"
            type="button"
            :aria-expanded="showSettings"
            @click="showSettings = !showSettings"
          >
            {{ t("agentProfiles.settings") }}
          </button>
          <RouterLink
            class="quiet-button"
            :to="{
              path: '/employees/bole',
              query: { q: agentDisplayName(agent) },
            }"
          >
            {{ t("agentProfiles.askHR") }}
          </RouterLink>
        </div>
      </header>

      <GrowthLoading
        v-if="loading || store.runtimeStatus === 'loading'"
        variant="compact"
        :label="t('agentProfiles.loading')"
      />
      <p v-if="error" class="agent-profile-refresh-status" role="status">
        {{ error }}
      </p>

      <AgentProfileSettings
        v-if="showSettings"
        :key="agent.agentId"
        :agent="agent"
        @saved="saved"
      />

      <GrowthLoading
        v-if="detailsLoading"
        variant="compact"
        :label="t('agentProfiles.detailLoading')"
      />

      <nav
        class="agent-profile-tabs"
        role="tablist"
        :aria-label="t('agentProfiles.profile')"
      >
        <button
          v-for="tab in profileTabs"
          :id="`agent-tab-${tab.id}`"
          :key="tab.id"
          class="agent-profile-tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`agent-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="selectTab(tab.id)"
          @keydown="onTabKeydown($event, profileTabs.findIndex((item) => item.id === tab.id))"
        >
          {{ tab.label }}
        </button>
      </nav>

      <p v-if="partial" class="agent-profile-partial" role="status">
        {{ t("agentProfiles.partial") }}
      </p>

      <section
        id="agent-panel-overview"
        class="agent-profile-panel"
        role="tabpanel"
        aria-labelledby="agent-tab-overview"
        :aria-hidden="activeTab !== 'overview'"
        v-show="activeTab === 'overview'"
        tabindex="0"
      >
        <div class="agent-profile-primary-grid">
          <section class="ui-card agent-resume-section agent-current-work-section">
            <div class="agent-section-heading">
              <h2>{{ t("agentProfiles.working") }}</h2>
              <span v-if="currentWork.length">{{ currentWork.length }}</span>
            </div>
            <ul v-if="currentWork.length" class="agent-current-work-list">
              <li v-for="task in currentWork" :key="task.taskId">
                <RouterLink
                  :to="{
                    path: '/project-agents/manage',
                    query: { agent: agent.agentId, task: task.taskId },
                  }"
                >
                  {{ task.title }}
                </RouterLink>
                <span class="ui-badge">{{ t(`projectAgents.taskStatus.${task.status}`) }}</span>
              </li>
            </ul>
            <p v-else-if="!detailsLoading && !partial" class="agent-muted">
              {{ t("agentProfiles.idle") }}
            </p>
            <p v-else-if="!detailsLoading" class="agent-muted">
              {{ t("agentProfiles.partial") }}
            </p>
          </section>

          <section class="ui-card agent-resume-section agent-projects-section">
            <div class="agent-section-heading">
              <h2>{{ t("agentProfiles.projects") }}</h2>
              <span>{{ currentProjects.length }}</span>
            </div>
            <ul class="agent-resume-list agent-current-project-list">
              <li v-for="id in visibleCurrentProjects" :key="id" class="agent-project-item">
                <h3>
                  <RouterLink
                    class="agent-project-link"
                    :to="personalProjectsPath(space, 'graph', id)"
                  >
                    {{ projectName(id) }}
                  </RouterLink>
                </h3>
                <p v-if="projectResponsibility(id)" class="agent-project-responsibility">
                  {{ projectResponsibility(id) }}
                </p>
              </li>
            </ul>
            <UiDisclosure
              v-if="remainingCurrentProjects.length"
              class="agent-project-overflow"
              :title="projectOverflowLabel"
            >
              <ul class="agent-resume-list">
                <li v-for="id in remainingCurrentProjects" :key="id" class="agent-project-item">
                  <h3>
                    <RouterLink
                      class="agent-project-link"
                      :to="personalProjectsPath(space, 'graph', id)"
                    >
                      {{ projectName(id) }}
                    </RouterLink>
                  </h3>
                  <p v-if="projectResponsibility(id)" class="agent-project-responsibility">
                    {{ projectResponsibility(id) }}
                  </p>
                </li>
              </ul>
            </UiDisclosure>
            <p
              v-if="!detailsLoading && !currentProjects.length"
              class="agent-muted"
            >
              {{ t("agentProfiles.noProject") }}
            </p>
          </section>

        </div>
      </section>

      <section
        id="agent-panel-history"
        class="agent-profile-panel"
        role="tabpanel"
        aria-labelledby="agent-tab-history"
        :aria-hidden="activeTab !== 'history'"
        v-show="activeTab === 'history'"
        tabindex="0"
      >
        <section class="ui-card agent-resume-section">
          <h2>{{ t("agentProfiles.projects") }}</h2>
          <details v-if="previousProjects.length" class="ui-disclosure" open>
            <summary>{{ t("agentProfiles.projectHistory") }}</summary>
            <ul class="agent-resume-list">
              <li v-for="item in previousProjects" :key="item.assignmentId">
                <h3>
                  <RouterLink
                    class="agent-project-link"
                    :to="personalProjectsPath(space, 'graph', item.personalProjectId)"
                  >
                    {{ projectName(item.personalProjectId) }}
                  </RouterLink>
                </h3>
                <p>{{ item.responsibility }}</p>
                <small>{{ date(item.assignedAt) }} – {{ date(item.endedAt) }}</small>
              </li>
            </ul>
          </details>
          <p v-else-if="!detailsLoading" class="agent-muted">
            {{ t("agentProfiles.noProject") }}
          </p>
        </section>
        <section class="ui-card agent-resume-section">
          <h2>{{ t("agentProfiles.experience") }}</h2>
          <p class="agent-muted">{{ t("agentProfiles.recent") }}</p>
          <ol class="agent-work-timeline">
            <li v-for="task in tasks.slice(0, 12)" :key="task.taskId">
              <div class="agent-section-heading">
                <RouterLink
                  :to="{
                    path: '/project-agents/manage',
                    query: { agent: agent.agentId, task: task.taskId },
                  }"
                >
                  {{ task.title }}
                </RouterLink>
                <span>{{ t(`projectAgents.taskStatus.${task.status}`) }}</span>
              </div>
              <p v-if="task.resultSummary">{{ task.resultSummary }}</p>
              <small>{{ date(task.completedAt || task.updatedAt || task.createdAt) }}</small>
            </li>
            <li v-if="agent.recruitedAt || agent.recruitmentReason">
              <h3>{{ t("agentProfiles.recruitment") }}</h3>
              <p v-if="agent.recruitmentReason">{{ agent.recruitmentReason }}</p>
              <small>{{ date(agent.recruitedAt) }}</small>
            </li>
          </ol>
          <p
            v-if="
              !detailsLoading &&
              !tasks.length &&
              !agent.recruitmentReason &&
              !agent.recruitedAt
            "
            class="agent-muted"
          >
            {{ t("agentProfiles.noExperience") }}
          </p>
        </section>
      </section>

      <section
        id="agent-panel-style"
        class="agent-profile-panel"
        role="tabpanel"
        aria-labelledby="agent-tab-style"
        :aria-hidden="activeTab !== 'style'"
        v-show="activeTab === 'style'"
        tabindex="0"
      >
        <section class="ui-card agent-resume-section">
          <h2>{{ t("agentProfiles.about") }}</h2>
          <div class="agent-character">
            <div
              v-for="key in ['judgment', 'taste', 'personality'] as const"
              :key="key"
            >
              <h3>{{ t(`agentProfiles.${key}`) }}</h3>
              <p :class="{ 'agent-muted': !agent.profile.character?.[key] }">
                {{
                  agent.profile.character?.[key] ||
                  t("agentProfiles.characterEmpty")
                }}
              </p>
            </div>
          </div>
          <p v-if="agent.profile.expectations" class="agent-expectation">
            <strong>{{ t("agentProfiles.expectations") }}</strong>
            {{ agent.profile.expectations }}
          </p>
          <div class="agent-strengths">
            <h3>{{ t("agentProfiles.strengths") }}</h3>
            <div class="agent-inline-skills">
              <span v-for="skill in agent.profile.capabilities" :key="skill">
                {{ skill }}
              </span>
              <span v-if="!agent.profile.capabilities.length">
                {{ t("agentProfiles.noSkills") }}
              </span>
            </div>
          </div>
        </section>
      </section>

      <section
        id="agent-panel-collaborators"
        class="agent-profile-panel"
        role="tabpanel"
        aria-labelledby="agent-tab-collaborators"
        :aria-hidden="activeTab !== 'collaborators'"
        v-show="activeTab === 'collaborators'"
        tabindex="0"
      >
        <section class="ui-card agent-resume-section">
          <div class="agent-section-heading">
            <h2>{{ t("agentProfiles.organization") }}</h2>
            <RouterLink
              :to="{
                path: '/employees/bole',
                query: { q: agentDisplayName(agent) },
              }"
            >
              {{ t("agentProfiles.hr") }}
            </RouterLink>
          </div>
          <div
            v-for="team in teams"
            :key="team.projectId"
            class="agent-organization"
          >
            <h3>{{ projectName(team.projectId) }}</h3>
            <p v-if="team.error" role="status">
              {{ t("agentProfiles.teamUnavailable") }}
            </p>
            <template
              v-else-if="
                team.policy?.teamLeadAgentId ||
                team.policy?.teamMemberAgentIds?.length
              "
            >
              <div v-if="team.policy.teamLeadAgentId" class="agent-org-lead">
                <span>{{ t("agentProfiles.lead") }}</span>
                <AgentName
                  :space-id="space"
                  :agent-id="team.policy.teamLeadAgentId"
                  :name="personName(team.policy.teamLeadAgentId)"
                />
              </div>
              <p v-if="team.policy.teamLeadAgentId" class="agent-org-reporting">
                {{ t("agentProfiles.reporting") }}
              </p>
              <div
                v-if="team.policy.teamMemberAgentIds?.length"
                class="agent-org-members"
              >
                <span>{{ t("agentProfiles.teammates") }}</span>
                <ul>
                  <li
                    v-for="id in [
                      ...new Set(team.policy.teamMemberAgentIds),
                    ].filter((id) => id !== team.policy?.teamLeadAgentId)"
                    :key="id"
                  >
                    <AgentName
                      :space-id="space"
                      :agent-id="id"
                      :name="personName(id)"
                    />
                  </li>
                </ul>
              </div>
            </template>
            <p v-else class="agent-muted">{{ t("agentProfiles.teamUnset") }}</p>
          </div>
          <p v-if="!detailsLoading && !teams.length" class="agent-muted">
            {{ t("agentProfiles.noProject") }}
          </p>
        </section>
        <section class="ui-card agent-resume-section">
          <h2>{{ t("agentProfiles.collaborators") }}</h2>
          <ul class="agent-collaborators">
            <li v-for="person in collaborators" :key="person.agentId">
              <AgentName
                :space-id="space"
                :agent-id="person.agentId"
                :name="personName(person.agentId)"
              />
              <span>{{ t("agentProfiles.sharedTasks", { count: person.count }) }}</span>
            </li>
          </ul>
          <p v-if="!detailsLoading && !collaborators.length" class="agent-muted">
            {{ t("agentProfiles.noCollaborators") }}
          </p>
        </section>
      </section>

      <section
        v-if="agent.memoryScope === 'reviewed_agent'"
        id="agent-panel-conversations"
        class="agent-profile-panel"
        role="tabpanel"
        aria-labelledby="agent-tab-conversations"
        :aria-hidden="activeTab !== 'conversations'"
        v-show="activeTab === 'conversations'"
        tabindex="0"
      >
        <section class="ui-card agent-resume-section">
          <AgentConversations
            :key="agent.agentId"
            :personal-space-id="space"
            :agent-id="agent.agentId"
            :projects="employeeProjects"
          />
        </section>
      </section>

      <section
        id="agent-panel-management"
        class="agent-profile-panel"
        role="tabpanel"
        aria-labelledby="agent-tab-management"
        :aria-hidden="activeTab !== 'management'"
        v-show="activeTab === 'management'"
        tabindex="0"
      >
        <section class="ui-card agent-resume-section agent-management-card">
          <h2>{{ t("agentProfiles.advanced") }}</h2>
          <p class="agent-muted">{{ t("agentProfiles.locked") }}</p>
          <div class="agent-profile-management-links">
            <RouterLink
              v-if="workbench"
              class="quiet-button"
              :to="`/employees/${encodeURIComponent(workbench.id)}`"
            >
              {{ t("agentProfiles.workbench") }}
            </RouterLink>
            <RouterLink
              class="quiet-button"
              :to="{
                path: '/project-agents/manage',
                query: { agent: agent.agentId },
              }"
            >
              {{ t("agentProfiles.advanced") }}
            </RouterLink>
          </div>
        </section>
      </section>

      <footer class="agent-profile-footer">
        <RouterLink
          v-if="workbench"
          :to="`/employees/${encodeURIComponent(workbench.id)}`"
        >
          {{ t("agentProfiles.workbench") }}
        </RouterLink>
        <RouterLink
          :to="{
            path: '/project-agents/manage',
            query: { agent: agent.agentId },
          }"
        >
          {{ t("agentProfiles.advanced") }}
        </RouterLink>
      </footer>
    </template>
  </section>
</template>

<style src="@/features/agent-profile/agent-profile.css" />
