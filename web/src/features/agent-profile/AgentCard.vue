<script setup lang="ts">
import { employeeAvatarUrl } from "@/features/employees/avatars";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import GrowthLoading from "@/components/GrowthLoading.vue";
import PinIcon from "@/components/PinIcon.vue";
import AgentHand from "@/features/project-agents/AgentHand.vue";
import { currentLocale, t } from "@/i18n";
import { formatRelativeTime } from "@/lib/relative-time";
import { workbenchStatusDetail } from "./workbench-status-text";
import {
  agentDisplayName,
  agentProfilePath,
  profileProjectIds,
} from "./profile-model";
import type { AgentWorkbenchEntry } from "./agent-workbench";
import { agentPinsText } from "./agent-pins";
import type { ProjectAgentRecord } from "@/types";

const props = defineProps<{
  agent: ProjectAgentRecord;
  spaceId: string;
  projectNames?: Record<string, string>;
  managesAllProjects?: boolean;
  entry?: AgentWorkbenchEntry;
  pinned?: boolean;
  pinPending?: boolean;
}>();

const emit = defineEmits<{
  "toggle-pin": [pinned: boolean];
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
const workStatus = computed(() => props.entry?.status ?? "unreported");
const currentTaskTitle = computed(() =>
  props.entry?.title ?? t("agentRedesign.workbench.titleNotLoaded"),
);
const lastUpdate = computed(() =>
  formatRelativeTime(props.entry?.lastUpdateAt, currentLocale()),
);
const taskLink = computed(() => ({
  path: "/project-agents/manage",
  query: { agent: props.agent.agentId, task: props.entry?.taskId ?? "" },
}));
const statusDetail = computed(() => workbenchStatusDetail(props.entry));
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
    ended: "Ended",
  }[workStatus.value];
  return localized(
    `agentRedesign.workStatus.${workStatus.value}`,
    fallback ?? "Work status unavailable",
  );
});
const pinLabel = computed(() =>
  props.pinPending
    ? agentPinsText("saving", "Saving Agent pin…")
    : props.pinned
      ? agentPinsText("unpin", "Unpin Agent")
      : agentPinsText("pin", "Pin Agent"),
);
function togglePin() {
  emit("toggle-pin", !props.pinned);
}
</script>

<template>
  <article class="ui-card agent-card">
    <div class="agent-card-topline">
      <span class="agent-portrait small" aria-hidden="true">
        <img v-if="employeeAvatarUrl(agent.agentId)" :src="employeeAvatarUrl(agent.agentId)" alt="" />
        <template v-else>{{ agent.profile.occupationEmoji || name.slice(0, 1) }}</template>
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
        v-if="workStatus !== 'ended' && (agent.profile.status === 'active' || !['none', 'loading'].includes(workStatus))"
        class="agent-card-work-status"
        :class="workStatusClass"
        :data-work-status="workStatus"
        :aria-label="`${t('agentRedesign.workStatus.label')} · ${workStatusLabel}`"
      >
        {{ workStatusLabel }}
      </span>
      <button
        class="agent-card-pin quiet-button"
        data-agent-pin-toggle
        type="button"
        :aria-label="`${pinLabel} · ${name}`"
        :aria-pressed="Boolean(pinned)"
        :title="pinLabel"
        :disabled="pinPending"
        @click.stop="togglePin"
      >
        <GrowthLoading v-if="pinPending" variant="inline" :label="pinLabel" />
        <PinIcon v-else :filled="pinned" />
      </button>
    </div>
    <p v-if="entry?.taskId" class="agent-card-current" data-current-task>
      <span class="agent-card-current-label">{{ t("agentRedesign.workbench.current") }}</span>
      <RouterLink class="agent-card-current-task" :to="taskLink" :class="{ 'is-unloaded': !entry.title }">
        {{ currentTaskTitle }}
      </RouterLink>
      <span class="agent-card-last-update" :title="entry.lastUpdateAt ?? undefined" data-last-update>
        {{ lastUpdate ? t("agentRedesign.workbench.lastUpdate", { time: lastUpdate }) : t("agentRedesign.workbench.lastUpdateUnknown") }}
      </span>
    </p>
    <p v-if="statusDetail" class="agent-card-status-detail" :class="workStatusClass" :title="statusDetail" data-status-detail>{{ statusDetail }}</p>
    <p class="agent-card-responsibility" :title="t('agentRedesign.workbench.responsibility')">{{ agent.profile.responsibility }}</p>
    <div v-if="capabilities.length" class="agent-inline-skills">
      <span v-for="skill in capabilities" :key="skill">{{ skill }}</span>
    </div>
    <div class="agent-card-meta">
      <div class="agent-card-projects">
        <div v-if="projectLabels.length" class="agent-card-project-list">
          <span v-for="project in projectLabels" :key="project" class="ui-badge agent-card-project-badge" :title="project">
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

<style scoped>
.agent-card-pin {
  flex: 0 0 auto;
  width: var(--control-height-sm);
  min-height: var(--control-height-sm);
  padding: 0;
  color: var(--color-muted);
}

.agent-card-pin:hover:not(:disabled),
.agent-card-pin[aria-pressed="true"] {
  color: var(--color-accent);
}

.agent-card-pin[aria-pressed="true"] {
  border-color: var(--color-accent-line);
  background: var(--color-accent-soft);
}

.agent-card-pin svg {
  width: 18px;
  height: 18px;
}

.agent-card-projects {
  flex: 1;
}

.agent-card-project-list .agent-card-project-badge {
  display: block;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card-pin :deep(.growth-loading--inline) {
  width: 100%;
  justify-content: center;
}

.agent-card-pin :deep(.growth-loading__label) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
