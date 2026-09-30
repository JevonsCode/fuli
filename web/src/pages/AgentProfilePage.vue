<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { getJson } from "@/api/client";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
import GrowthLoading from "@/components/GrowthLoading.vue";
import AgentName from "@/features/agent-profile/AgentName.vue";
import AgentProfileSettings from "@/features/agent-profile/AgentProfileSettings.vue";
import {
  agentDisplayName,
  collaboratorsFor,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import { useAgentRoster } from "@/features/agent-profile/useAgentRoster";
import {
  arrayOf,
  normalizeAssignment,
  normalizeTask,
  unknownRecord,
} from "@/features/project-agents/task-evidence";
import { employeeTemplates } from "@/features/employees/catalog";
import type {
  ProjectAgentAssignmentRecord,
  ProjectAgentCoordinationPolicy,
  ProjectAgentRecord,
  ProjectAgentTaskRecord,
} from "@/types";
const route = useRoute(),
  store = useConsoleStore();
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
const projectName = (id: string) =>
  projects.value.find((item) => item.project_id === id)?.profile.name || id;
const personName = (id: string) => {
  const person = agents.value.find((item) => item.agentId === id);
  return person ? agentDisplayName(person) : id;
};
const tasks = ref<ProjectAgentTaskRecord[]>([]),
  assignments = ref<ProjectAgentAssignmentRecord[] | undefined>(undefined);
const teams = ref<
  Array<{
    projectId: string;
    policy: ProjectAgentCoordinationPolicy | null;
    error: boolean;
  }>
>([]);
const detailsLoading = ref(false),
  partial = ref(false),
  showSettings = ref(false);
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
const previousProjects = computed(() =>
  (assignments.value ?? []).filter((item) => item.status !== "active"),
);
const workbench = computed(() =>
  employeeTemplates.value.find((item) => item.agentId === agent.value?.agentId),
);
const date = (value?: string | null) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleDateString()
    : t("agentProfiles.timeUnknown");
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
    detailsLoading.value = true;
    assignments.value = person.assignments;
    const params = new URLSearchParams({
      personalSpaceId: person.personalSpaceId,
      agentId: person.agentId,
    });
    const results = await Promise.allSettled([
      getJson<unknown>(`/api/project-agent-tasks?${params}&limit=200`),
      getJson<unknown>(`/api/project-agent-assignments?${params}`),
    ]);
    if (current !== generation) return;
    const [taskResult, assignmentResult] = results;
    if (taskResult.status === "fulfilled") {
      const value = taskResult.value,
        record = unknownRecord(value);
      tasks.value = arrayOf(
        Array.isArray(value) ? value : (record.tasks ?? record.items),
      )
        .map(normalizeTask)
        .filter((item): item is ProjectAgentTaskRecord =>
          Boolean(
            item &&
            (!item.personalSpaceId ||
              item.personalSpaceId === person.personalSpaceId) &&
            item.participants.some(
              (member) => member.agentId === person.agentId,
            ),
          ),
        )
        .sort((a, b) =>
          (b.updatedAt ?? b.createdAt ?? "").localeCompare(
            a.updatedAt ?? a.createdAt ?? "",
          ),
        );
    } else partial.value = true;
    if (assignmentResult.status === "fulfilled") {
      const value = assignmentResult.value,
        record = unknownRecord(value);
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
  const index = agents.value.findIndex(
    (item) => item.agentId === person.agentId,
  );
  if (index >= 0) agents.value[index] = { ...agents.value[index], ...person };
}
onMounted(() => {
  if (store.runtimeStatus === "idle") void store.refresh();
});
</script>
<template>
  <section class="view agent-profile-page">
    <RouterLink class="agent-profile-back" to="/project-agents"
      >← {{ t("agentProfiles.back") }}</RouterLink
    >
    <GrowthLoading
      v-if="loading || store.runtimeStatus === 'loading'"
      :label="t('agentProfiles.loading')"
    />
    <div
      v-else-if="error || store.runtimeStatus === 'error'"
      class="agent-profile-empty"
      role="alert"
    >
      <p>{{ error || t("agentProfiles.loadError") }}</p>
      <button @click="store.state ? load() : store.refresh()">
        {{ t("agentProfiles.retry") }}
      </button>
    </div>
    <p v-else-if="!agent" class="agent-profile-empty">
      {{ t("agentProfiles.unavailable") }}
    </p>
    <template v-else>
      <header class="agent-resume-header">
        <span class="agent-portrait" aria-hidden="true">{{
          agent.profile.occupationEmoji || agentDisplayName(agent).slice(0, 1)
        }}</span>
        <div class="agent-resume-intro">
          <h1>{{ agentDisplayName(agent) }}</h1>
          <p>{{ agent.profile.responsibility }}</p>
          <div class="agent-resume-meta">
            <span>{{ t(`projectAgents.status.${agent.profile.status}`) }}</span
            ><span
              >{{
                t(
                  agent.recruitedAt
                    ? "agentProfiles.joined"
                    : "agentProfiles.created",
                )
              }}
              · {{ date(agent.recruitedAt || agent.createdAt) }}</span
            >
          </div>
        </div>
        <div class="agent-profile-actions">
          <button
            class="quiet-button"
            :aria-expanded="showSettings"
            @click="showSettings = !showSettings"
          >
            {{ t("agentProfiles.settings") }}</button
          ><RouterLink
            :to="{
              path: '/employees/bole',
              query: { q: agentDisplayName(agent) },
            }"
            >{{ t("agentProfiles.askHR") }}</RouterLink
          >
        </div>
      </header>
      <AgentProfileSettings
        v-if="showSettings"
        :key="agent.agentId"
        :agent="agent"
        @saved="saved"
      />
      <section class="agent-resume-section">
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
          <strong>{{ t("agentProfiles.expectations") }}</strong
          >{{ agent.profile.expectations }}
        </p>
        <div class="agent-strengths">
          <h3>{{ t("agentProfiles.strengths") }}</h3>
          <div class="agent-inline-skills">
            <span v-for="skill in agent.profile.capabilities" :key="skill">{{
              skill
            }}</span
            ><span v-if="!agent.profile.capabilities.length">{{
              t("agentProfiles.noSkills")
            }}</span>
          </div>
        </div>
      </section>
      <GrowthLoading
        v-if="detailsLoading"
        variant="compact"
        :label="t('agentProfiles.detailLoading')"
      />
      <p v-if="partial" role="status">{{ t("agentProfiles.partial") }}</p>
      <section class="agent-resume-section">
        <h2>{{ t("agentProfiles.projects") }}</h2>
        <ul class="agent-resume-list">
          <li v-for="id in currentProjects" :key="id">
            <h3>{{ projectName(id) }}</h3>
            <p>
              {{
                assignments?.find(
                  (item) =>
                    item.personalProjectId === id && item.status === "active",
                )?.responsibility || agent.profile.responsibility
              }}
            </p>
          </li>
        </ul>
        <p
          v-if="!detailsLoading && !currentProjects.length"
          class="agent-muted"
        >
          {{ t("agentProfiles.noProject") }}
        </p>
        <details v-if="previousProjects.length">
          <summary>{{ t("agentProfiles.projectHistory") }}</summary>
          <ul class="agent-resume-list">
            <li v-for="item in previousProjects" :key="item.assignmentId">
              <h3>{{ projectName(item.personalProjectId) }}</h3>
              <p>{{ item.responsibility }}</p>
              <small
                >{{ date(item.assignedAt) }} – {{ date(item.endedAt) }}</small
              >
            </li>
          </ul>
        </details>
      </section>
      <section class="agent-resume-section">
        <div class="agent-section-heading">
          <h2>{{ t("agentProfiles.organization") }}</h2>
          <RouterLink
            :to="{
              path: '/employees/bole',
              query: { q: agentDisplayName(agent) },
            }"
            >{{ t("agentProfiles.hr") }}</RouterLink
          >
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
            ><div v-if="team.policy.teamLeadAgentId" class="agent-org-lead">
              <span>{{ t("agentProfiles.lead") }}</span
              ><AgentName
                :space-id="space"
                :agent-id="team.policy.teamLeadAgentId"
                :name="personName(team.policy.teamLeadAgentId)"
              />
            </div>
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
              </ul></div
          ></template>
          <p v-else class="agent-muted">{{ t("agentProfiles.teamUnset") }}</p>
        </div>
        <p v-if="!detailsLoading && !teams.length" class="agent-muted">
          {{ t("agentProfiles.noProject") }}
        </p>
      </section>
      <section class="agent-resume-section">
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
                >{{ task.title }}</RouterLink
              ><span>{{ t(`projectAgents.taskStatus.${task.status}`) }}</span>
            </div>
            <p v-if="task.resultSummary">{{ task.resultSummary }}</p>
            <small>{{
              date(task.completedAt || task.updatedAt || task.createdAt)
            }}</small>
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
      <section class="agent-resume-section">
        <h2>{{ t("agentProfiles.collaborators") }}</h2>
        <ul class="agent-collaborators">
          <li v-for="person in collaborators" :key="person.agentId">
            <AgentName
              :space-id="space"
              :agent-id="person.agentId"
              :name="personName(person.agentId)"
            /><span>{{
              t("agentProfiles.sharedTasks", { count: person.count })
            }}</span>
          </li>
        </ul>
        <p v-if="!detailsLoading && !collaborators.length" class="agent-muted">
          {{ t("agentProfiles.noCollaborators") }}
        </p>
      </section>
      <footer class="agent-profile-footer">
        <RouterLink
          v-if="workbench"
          :to="`/employees/${encodeURIComponent(workbench.id)}`"
          >{{ t("agentProfiles.workbench") }}</RouterLink
        ><RouterLink
          :to="{
            path: '/project-agents/manage',
            query: { agent: agent.agentId },
          }"
          >{{ t("agentProfiles.advanced") }}</RouterLink
        >
      </footer>
    </template>
  </section>
</template>
<style src="@/features/agent-profile/agent-profile.css" />
