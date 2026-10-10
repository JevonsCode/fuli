<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import AgentHand from "@/features/project-agents/AgentHand.vue";
import { t } from "@/i18n";
import {
  agentDisplayName,
  agentProfilePath,
  profileProjectIds,
} from "./profile-model";
import type {
  AgentWorkSummary,
} from "./agent-work-summary";
import type { AgentWorkSummaryState } from "./useAgentWorkSummary";
import type { ProjectAgentRecord } from "@/types";

const props = defineProps<{
  agent: ProjectAgentRecord;
  spaceId: string;
  projectNames?: Record<string, string>;
  managesAllProjects?: boolean;
  workSummary?: AgentWorkSummary;
  workState?: AgentWorkSummaryState;
}>();

const name = computed(() => agentDisplayName(props.agent));
const projectIds = computed(() => profileProjectIds(props.agent));
const projectLabels = computed(() =>
  projectIds.value.slice(0, 2).map((id) => props.projectNames?.[id] || id),
);
const projectCount = computed(() => Math.max(projectIds.value.length - 2, 0));
const capabilities = computed(() => props.agent.profile.capabilities.slice(0, 3));
const statusClass = computed(() => `is-${props.agent.profile.status}`);
const reportedMembershipStatus = computed(() =>
  t(`projectAgents.status.${props.agent.profile.status}`),
);
const workStatus = computed(() => {
  if (props.workSummary) return props.workSummary.status;
  if (props.workState === "loading") return "loading";
  if (props.workState === "error") return "unavailable";
  if (props.workState === "incomplete") return "unreported";
  return "none";
});
const workStatusClass = computed(() => `is-${workStatus.value}`);
// Jefa and Bole are fixed roles every space has.
const fixedRole = computed(() => ({ coordinator: t("agentProfiles.roles.projectManager"), hr: t("agentProfiles.roles.hr") })[props.agent.profile.agentType as string] ?? "");
function localized(
  key: string,
  fallback: string,
  values?: Record<string, string | number>,
) {
  const translated = t(key, values);
  return translated === key ? fallback : translated;
}
const membershipStatusLabel = computed(() =>
  localized(
    "agentRedesign.membershipStatus",
    `Member · ${reportedMembershipStatus.value}`,
    { status: reportedMembershipStatus.value },
  ),
);
const workStatusLabel = computed(() => {
  const fallback = {
    awaiting_recruitment: "Awaiting recruitment",
    queued: "Queued",
    running: "Running",
    paused: "Paused",
    awaiting_review: "Awaiting review",
    blocked: "Blocked",
    none: t("agentProfiles.idle"),
    loading: "Loading work status",
    unreported: "Partial status",
    unavailable: "Unavailable",
  }[workStatus.value];
  return localized(
    `agentRedesign.workStatus.${workStatus.value}`,
    fallback ?? "Work status unavailable",
  );
});
</script>

<template>
  <article class="ui-card agent-card">
    <div class="agent-card-topline">
      <span class="agent-portrait small" aria-hidden="true">
        {{ agent.profile.occupationEmoji || name.slice(0, 1) }}
      </span>
      <div class="agent-directory-name">
        <RouterLink
          :to="agentProfilePath(spaceId, agent.agentId)"
          :aria-label="`${name} · ${t('agentProfiles.profile')}`"
        >
          {{ name }}
        </RouterLink>
        <span v-if="agent.employeeNumber" class="ui-badge fla-employee-number">FLA {{ agent.employeeNumber }}</span>
        <span v-if="fixedRole" class="ui-badge ui-badge--accent agent-card-role">{{ fixedRole }}</span>
        <AgentHand :agent-id="agent.agentId" />
      </div>
      <span
        v-if="agent.profile.status !== 'active'"
        class="ui-badge agent-card-status agent-card-membership-status"
        :class="statusClass"
        :data-membership-status="agent.profile.status"
      >
        {{ membershipStatusLabel }}
      </span>
      <span
        v-if="agent.profile.status === 'active' || !['none', 'loading'].includes(workStatus)"
        class="agent-card-work-status"
        :class="workStatusClass"
        :data-work-status="workStatus"
        :aria-label="`${t('agentRedesign.workStatus.label')} · ${workStatusLabel}`"
      >
        {{ workStatusLabel }}
      </span>
    </div>
    <p class="agent-card-responsibility">{{ agent.profile.responsibility }}</p>
    <div v-if="capabilities.length" class="agent-inline-skills">
      <span v-for="skill in capabilities" :key="skill">{{ skill }}</span>
    </div>
    <div class="agent-card-meta">
      <div class="agent-card-projects">
        <div v-if="projectLabels.length" class="agent-card-project-list">
          <span v-for="project in projectLabels" :key="project" class="ui-badge">
            {{ project }}
          </span>
          <span v-if="projectCount" class="ui-badge agent-card-project-count">
            +{{ projectCount }}
          </span>
        </div>
        <span v-else-if="managesAllProjects" class="ui-badge">{{ t("agentProfiles.allProjects") }}</span>
        <span v-else class="agent-card-no-project">{{ t("agentProfiles.noProject") }}</span>
      </div>
      <RouterLink
        class="agent-directory-open"
        :to="agentProfilePath(spaceId, agent.agentId)"
        :aria-label="`${name} · ${t('agentProfiles.profile')}`"
      >
        {{ t("agentProfiles.profile") }} →
      </RouterLink>
    </div>
  </article>
</template>
