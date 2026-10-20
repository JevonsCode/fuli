<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ActivityOriginBadge from "@/features/agent-profile/ActivityOriginBadge.vue";
import { employeeAvatarUrl } from "@/features/employees/avatars";
import { agentIdentityStyle } from "@/features/agent-profile/agent-identity-color";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { getJson } from "@/api/client";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
import BackLink from "@/components/BackLink.vue";
import GrowthLoading from "@/components/GrowthLoading.vue";
import UiDisclosure from "@/components/UiDisclosure.vue";
import AgentName from "@/features/agent-profile/AgentName.vue";
import AgentProfileSettings from "@/features/agent-profile/AgentProfileSettings.vue";
import AgentOccupationEditor from "@/features/agent-profile/AgentOccupationEditor.vue";
import OccupationChip from "@/features/occupations/OccupationChip.vue";
import { useOccupationCatalog } from "@/features/occupations/occupation-catalog";
import AgentConversations from "@/features/project-agents/AgentConversations.vue";
import TaskExecutionPlan from "@/features/project-agents/TaskExecutionPlan.vue";
import {
  agentDisplayName,
  collaboratorsFor,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import { isAgentTaskDataComplete, taskHasAgent } from "@/features/agent-profile/agent-work-summary";
import { useAgentRecords } from "@/features/agent-profile/useAgentRecords";
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
  ProjectAgentRecord,
  ProjectAgentTaskRecord,
} from "@/types";
import { personalProjectsPath } from "@/router/paths";
import { readProjectTeam, type ProjectTeam } from "@/features/projects/project-team-api";
import { usePageTitle } from "@/layouts/page-title";
import { taskStatusTone } from "@/features/project-agents/task-labels";
import { agentManagementPath } from "@/features/project-agents/orchestration-filters";

type ProfileTab =
  | "overview"
  | "history"
  | "style"
  | "collaborators"
  | "conversations"
  | "management";

const route = useRoute();
const router = useRouter();
const store = useConsoleStore();
const space = computed(() => store.activePersonalSpace?.id ?? "");
// Only this Agent is read; the Provider resolves a legacy id to its current record.
const routeAgentId = computed(() =>
  route.params.spaceId === space.value ? String(route.params.agentId ?? "") : "",
);
const self = useAgentRecords(space, computed(() => (routeAgentId.value ? [routeAgentId.value] : [])));
const { loading, error } = self;
const load = () => self.load({ force: true });
const agent = computed(() =>
  routeAgentId.value ? self.records.value[routeAgentId.value] : undefined,
);
const projects = computed(() =>
  (store.state?.personalProjects ?? []).filter(
    (item) => item.personal_space_id === space.value,
  ),
);
const projectName = (id: string) =>
  projects.value.find((item) => item.project_id === id)?.profile.name || id;

const tasks = ref<ProjectAgentTaskRecord[]>([]);
const assignments = ref<ProjectAgentAssignmentRecord[] | undefined>(undefined);
const teams = ref<
  Array<{
    projectId: string;
    view: ProjectTeam | null;
    error: boolean;
  }>
>([]);
const detailsLoading = ref(false);
const partial = ref(false);
const showSettings = ref(false);

const profileTabs = computed(() => {
  const tabs: Array<{ id: ProfileTab; label: string }> = [
    { id: "overview", label: t("agentProfiles.overviewTab") },
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
// The open tab is part of the URL (?tab=), so a refresh or a shared link
// lands on it; switching tabs replaces the entry instead of adding history.
const activeTab = computed<ProfileTab>({
  get: () => {
    const tab = route.query.tab;
    return profileTabs.value.find((item) => item.id === tab)?.id ?? "overview";
  },
  set: (tab) => {
    const { tab: _previous, ...query } = route.query;
    void router.replace({ query: tab === "overview" ? query : { ...query, tab } });
  },
});
// The shell's one H1 is this Agent's real name; the route title is only the
// fallback while it loads or when the Agent is unavailable.
usePageTitle(() => (agent.value ? agentDisplayName(agent.value) : ""));
// "← 全部 Agent" goes Back when the directory opened this page, restoring its
// filters, scroll and focused card.
const openedFromDirectory = /^\/project-agents(\?|$)/;
const collaborators = computed(() =>
  agent.value ? collaboratorsFor(agent.value.agentId, tasks.value) : [],
);
// Collaborator names are read for the people shown; an unread name falls back to the id.
const collaboratorRecords = useAgentRecords(
  space,
  computed(() => collaborators.value.map((person) => person.agentId)),
);
const personName = (id: string) => {
  const person = collaboratorRecords.records.value[id];
  return person ? agentDisplayName(person) : id;
};
const currentProjects = computed(() =>
  agent.value
    ? profileProjectIds({
        ...agent.value,
        assignments: assignments.value ?? agent.value.assignments,
      })
    : [],
);
const conversationProjects = computed(() =>
  projects.value
    .filter((item) => currentProjects.value.includes(item.project_id))
    .map((item) => ({ id: item.project_id, name: item.profile.name })),
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
// Main role first, then tags; each chip opens the duties from the catalog.
const occupationKeys = computed(() => {
  const occupation = agent.value?.occupation;
  if (!occupation) return [];
  return [...new Set([...(occupation.role ? [occupation.role] : []), ...occupation.tags])];
});
useOccupationCatalog(computed(() => agent.value?.personalSpaceId ?? ""));
const workbench = computed(() =>
  employeeTemplates.value.find((item) => item.agentId === agent.value?.agentId),
);
// Bole is the AR: its own profile has nobody else to ask.
const isAr = computed(() => workbench.value?.id === "bole");
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
    if (!person) return;
    void refreshEmployeeCatalog(person.personalSpaceId);
    detailsLoading.value = true;
    assignments.value = person.assignments;
    const params = new URLSearchParams({
      personalSpaceId: person.personalSpaceId,
      agentId: person.agentId,
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
          const view = await readProjectTeam(person.personalSpaceId, projectId);
          return { projectId, view, error: false };
        } catch {
          return { projectId, view: null, error: true };
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
  if (agent.value) self.put(routeAgentId.value, { ...agent.value, ...person });
}

onMounted(() => {
  if (store.runtimeStatus === "idle") void store.refresh();
});
</script>

<template>
  <section
    class="view agent-profile-page"
    :aria-label="agent ? agentDisplayName(agent) : t('agentProfiles.profile')"
  >
    <div class="@container mx-auto grid w-full max-w-(--canvas-max) gap-4">
      <BackLink class="agent-profile-back" to="/project-agents" :from="openedFromDirectory">{{ t("agentProfiles.back") }}</BackLink>

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
        <Button size="sm" variant="outline" @click="store.state ? load() : store.refresh()">
          {{ t("agentProfiles.retry") }}
        </Button>
      </div>
      <p v-else-if="!agent" class="ui-card ui-empty agent-profile-empty">
        {{ t("agentProfiles.unavailable") }}
      </p>
      <template v-else>
        <!-- The name is the page's H1 (in the top bar), so the summary card
             carries only what the name does not say. -->
        <Card as="header" class="agent-resume-header">
          <span class="agent-portrait agent-identity" :style="agentIdentityStyle(agent.agentId)" aria-hidden="true">
            <img v-if="employeeAvatarUrl(agent.agentId)" :src="employeeAvatarUrl(agent.agentId)" alt="" />
            <template v-else>{{ agent.profile.occupationEmoji || agentDisplayName(agent).slice(0, 1) }}</template>
          </span>
          <div class="agent-resume-intro grid min-w-0 flex-[1_1_360px] gap-2">
            <div class="agent-resume-name-row flex-wrap justify-start gap-2">
              <span v-if="agent.employeeNumber" class="ui-badge fla-employee-number">FLA {{ agent.employeeNumber }}</span>
              <span class="ui-badge agent-profile-membership" :class="`is-${agent.profile.status}`">
                {{ t(`projectAgents.status.${agent.profile.status}`) }}
              </span>
            </div>
            <p class="agent-resume-occupation" data-profile-occupation>
              <template v-if="occupationKeys.length">
                <OccupationChip v-for="(key, index) in occupationKeys" :key="key" :occupation-key="key" :main="index === 0 && Boolean(agent.occupation?.role)" />
              </template>
              <span v-else class="ui-meta">{{ t("agentRedesign.occupation.notSet") }}</span>
            </p>
            <p class="agent-resume-summary">{{ agent.profile.responsibility }}</p>
            <div class="agent-resume-meta">
              <span>
                {{ t(agent.recruitedAt ? "agentProfiles.joined" : "agentProfiles.created") }}
                · {{ date(agent.recruitedAt || agent.createdAt) }}
              </span>
            </div>
          </div>
          <div class="agent-profile-actions">
            <Button v-if="workbench" as-child variant="outline">
              <RouterLink :to="`/employees/${encodeURIComponent(workbench.id)}`">
                {{ t("agentProfiles.workbench") }}
              </RouterLink>
            </Button>
            <Button
              variant="outline"
              :aria-expanded="showSettings"
              @click="showSettings = !showSettings"
            >
              {{ t("agentProfiles.settings") }}
            </Button>
            <Button v-if="!isAr" as-child variant="outline">
              <RouterLink :to="{ path: '/employees/bole', query: { q: agentDisplayName(agent) } }">
                {{ t("agentProfiles.askHR") }}
              </RouterLink>
            </Button>
          </div>
        </Card>

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
        <AgentOccupationEditor
          v-if="showSettings && agent.profile.status !== 'archived'"
          :key="`occupation-${agent.agentId}`"
          :agent="agent"
          @saved="saved"
        />

        <Tabs v-model="activeTab" :unmount-on-hide="false" class="agent-profile-tabs mt-2">
          <TabsList :aria-label="agentDisplayName(agent)">
            <TabsTrigger v-for="tab in profileTabs" :key="tab.id" :value="tab.id" :data-profile-tab="tab.id">
              {{ tab.label }}
            </TabsTrigger>
          </TabsList>

          <GrowthLoading
            v-if="detailsLoading"
            variant="compact"
            :label="t('agentProfiles.detailLoading')"
          />
          <p v-if="partial" class="agent-profile-partial" role="status">
            {{ t("agentProfiles.partial") }}
          </p>

          <TabsContent value="overview" class="agent-profile-panel" data-profile-panel="overview">
            <div class="agent-profile-primary-grid">
              <Card as="section" class="agent-resume-section agent-current-work-section" aria-labelledby="agent-current-work-heading">
                <div class="agent-section-heading">
                  <h2 id="agent-current-work-heading">{{ t("agentProfiles.working") }}</h2>
                  <span v-if="currentWork.length">{{ currentWork.length }}</span>
                </div>
                <ul v-if="currentWork.length" class="agent-current-work-list">
                  <li v-for="task in currentWork" :key="task.taskId">
                    <RouterLink :to="{ path: agentManagementPath(agent.personalSpaceId, agent.agentId), query: { task: task.taskId } }">
                      {{ task.title }}
                    </RouterLink>
                    <Badge :variant="taskStatusTone(task.status)">{{ t(`projectAgents.taskStatus.${task.status}`) }}</Badge>
                    <ActivityOriginBadge :origin="task.activityOrigin" />
                    <TaskExecutionPlan :task="task" :personal-space-id="space" :active="activeTab === 'overview'" />
                  </li>
                </ul>
                <p v-else-if="!detailsLoading && !partial" class="agent-muted">
                  {{ t("agentProfiles.idle") }}
                </p>
                <p v-else-if="!detailsLoading" class="agent-muted">
                  {{ t("agentProfiles.partial") }}
                </p>
              </Card>

              <Card as="section" class="agent-resume-section agent-projects-section" aria-labelledby="agent-projects-heading">
                <div class="agent-section-heading">
                  <h2 id="agent-projects-heading">{{ t("agentProfiles.projects") }}</h2>
                  <span>{{ currentProjects.length }}</span>
                </div>
                <ul class="agent-resume-list agent-current-project-list">
                  <li v-for="id in visibleCurrentProjects" :key="id" class="agent-project-item">
                    <h3>
                      <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', id)">
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
                        <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', id)">
                          {{ projectName(id) }}
                        </RouterLink>
                      </h3>
                      <p v-if="projectResponsibility(id)" class="agent-project-responsibility">
                        {{ projectResponsibility(id) }}
                      </p>
                    </li>
                  </ul>
                </UiDisclosure>
                <p v-if="!detailsLoading && !currentProjects.length" class="agent-muted">
                  {{ t("agentProfiles.noProject") }}
                </p>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="history" class="agent-profile-panel" data-profile-panel="history">
            <div class="agent-profile-history-grid">
              <Card as="section" class="agent-resume-section" aria-labelledby="agent-history-projects-heading">
                <h2 id="agent-history-projects-heading">{{ t("agentProfiles.projects") }}</h2>
                <details v-if="previousProjects.length" class="ui-disclosure" open>
                  <summary>{{ t("agentProfiles.projectHistory") }}</summary>
                  <ul class="agent-resume-list">
                    <li v-for="item in previousProjects" :key="item.assignmentId">
                      <h3>
                        <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', item.personalProjectId)">
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
              </Card>
              <Card as="section" class="agent-resume-section" aria-labelledby="agent-history-recent-heading">
                <h2 id="agent-history-recent-heading">{{ t("agentProfiles.recent") }}</h2>
                <ol class="agent-work-timeline">
                  <li v-if="agent.archiveReason" data-profile-departure>
                    <h3>{{ t("agentProfiles.departure") }}</h3>
                    <p>{{ agent.archiveReason }}</p>
                    <small>{{ date(agent.archivedAt) }}</small>
                  </li>
                  <li v-for="task in tasks.slice(0, 12)" :key="task.taskId">
                    <div class="agent-section-heading">
                      <RouterLink :to="{ path: agentManagementPath(agent.personalSpaceId, agent.agentId), query: { task: task.taskId } }">
                        {{ task.title }}
                      </RouterLink>
                      <span>{{ t(`projectAgents.taskStatus.${task.status}`) }}</span>
                      <ActivityOriginBadge :origin="task.activityOrigin" />
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
                  v-if="!detailsLoading && !tasks.length && !agent.archiveReason && !agent.recruitmentReason && !agent.recruitedAt"
                  class="agent-muted"
                >
                  {{ t("agentProfiles.noExperience") }}
                </p>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="style" class="agent-profile-panel" data-profile-panel="style">
            <Card as="section" class="agent-resume-section" :aria-label="t('agentProfiles.about')">
              <div class="agent-character">
                <div v-for="key in ['judgment', 'taste', 'personality'] as const" :key="key">
                  <h3>{{ t(`agentProfiles.${key}`) }}</h3>
                  <p :class="{ 'agent-muted': !agent.profile.character?.[key] }">
                    {{ agent.profile.character?.[key] || t("agentProfiles.characterEmpty") }}
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
                  <span v-for="skill in agent.profile.capabilities" :key="skill">{{ skill }}</span>
                  <span v-if="!agent.profile.capabilities.length">{{ t("agentProfiles.noSkills") }}</span>
                </div>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="collaborators" class="agent-profile-panel" data-profile-panel="collaborators">
            <div class="agent-profile-history-grid">
              <Card as="section" class="agent-resume-section" aria-labelledby="agent-organization-heading">
                <div class="agent-section-heading">
                  <h2 id="agent-organization-heading">{{ t("agentProfiles.organization") }}</h2>
                  <RouterLink v-if="!isAr" :to="{ path: '/employees/bole', query: { q: agentDisplayName(agent) } }">
                    {{ t("agentProfiles.hr") }}
                  </RouterLink>
                </div>
                <div v-for="team in teams" :key="team.projectId" class="agent-organization">
                  <h3>{{ projectName(team.projectId) }}</h3>
                  <p v-if="team.error" role="status">
                    {{ t("agentProfiles.teamUnavailable") }}
                  </p>
                  <template v-else-if="team.view && (team.view.lead || team.view.unavailableLead || team.view.members.length)">
                    <p v-if="team.view.unavailableLead" class="agent-org-lead-unavailable" role="status">
                      {{
                        team.view.unavailableLead.name
                          ? t("agentProfiles.leadUnavailable", { name: team.view.unavailableLead.name })
                          : t("agentProfiles.leadUnavailableUnnamed")
                      }}
                    </p>
                    <div v-if="team.view.lead" class="agent-org-lead">
                      <span>{{ t("agentProfiles.lead") }}</span>
                      <AgentName :space-id="space" :agent-id="team.view.lead.agentId" :name="team.view.lead.name" />
                    </div>
                    <p v-if="team.view.lead" class="agent-org-reporting">
                      {{ t("agentProfiles.reporting") }}
                    </p>
                    <div v-if="team.view.members.length" class="agent-org-members">
                      <span>{{ t("agentProfiles.teammates") }}</span>
                      <ul>
                        <li v-for="member in team.view.members" :key="member.agentId">
                          <AgentName :space-id="space" :agent-id="member.agentId" :name="member.name" />
                        </li>
                      </ul>
                    </div>
                  </template>
                  <p v-else class="agent-muted">{{ t("agentProfiles.teamUnset") }}</p>
                </div>
                <p v-if="!detailsLoading && !teams.length" class="agent-muted">
                  {{ t("agentProfiles.noProject") }}
                </p>
              </Card>
              <Card as="section" class="agent-resume-section" aria-labelledby="agent-worked-with-heading">
                <h2 id="agent-worked-with-heading">{{ t("agentProfiles.workedWith") }}</h2>
                <ul class="agent-collaborators">
                  <li v-for="person in collaborators" :key="person.agentId">
                    <AgentName :space-id="space" :agent-id="person.agentId" :name="personName(person.agentId)" />
                    <span>{{ t("agentProfiles.sharedTasks", { count: person.count }) }}</span>
                  </li>
                </ul>
                <p v-if="!detailsLoading && !collaborators.length" class="agent-muted">
                  {{ t("agentProfiles.noCollaborators") }}
                </p>
              </Card>
            </div>
          </TabsContent>

          <TabsContent
            v-if="agent.memoryScope === 'reviewed_agent'"
            value="conversations"
            class="agent-profile-panel"
            data-profile-panel="conversations"
          >
            <Card as="section" class="agent-resume-section">
              <AgentConversations
                :key="agent.agentId"
                :personal-space-id="space"
                :agent-id="agent.agentId"
                :projects="conversationProjects"
              />
            </Card>
          </TabsContent>

          <TabsContent value="management" class="agent-profile-panel" data-profile-panel="management">
            <Card as="section" class="agent-resume-section agent-management-card" :aria-label="t('agentProfiles.advanced')">
              <p class="agent-muted">{{ t("agentProfiles.locked") }}</p>
              <div class="agent-profile-management-links">
                <Button as-child variant="outline">
                  <RouterLink data-open-management :to="agentManagementPath(agent.personalSpaceId, agent.agentId)">
                    {{ t("agentProfiles.openManagement") }}
                  </RouterLink>
                </Button>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </template>
    </div>
  </section>
</template>

<style src="@/features/agent-profile/agent-profile.css" />

<style scoped>
.agent-profile-page { scrollbar-gutter: stable; }
.agent-portrait.agent-identity {
  color: var(--agent-identity, var(--color-accent));
  background: var(--agent-identity-soft, var(--color-accent-soft));
}

.agent-portrait.agent-identity:has(img) {
  box-shadow: 0 0 0 2px var(--agent-identity, transparent);
}
/* Panels use the canvas: wide screens put related cards side by side. */
.agent-profile-history-grid { display: grid; gap: var(--space-4); }
@container (min-width: 960px) {
  .agent-profile-history-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
}
@container (min-width: 1400px) {
  .agent-profile-primary-grid { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
}
</style>
