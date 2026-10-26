<script setup lang="ts">
import { employeeAvatarUrl } from "@/features/employees/avatars";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PinIcon from "@/components/PinIcon.vue";
import AgentHand from "@/features/project-agents/AgentHand.vue";
import { currentLocale, t } from "@/i18n";
import { useNow } from "@/composables/useNow";
import { formatElapsed } from "@/lib/elapsed-time";
import { formatRelativeTime } from "@/lib/relative-time";
import { workbenchStatusDetail } from "./workbench-status-text";
import {
  agentDisplayName,
  agentProfilePath,
  agentResponsibility,
  profileProjectIds,
} from "./profile-model";
import type { AgentWorkbenchEntry } from "./agent-workbench";
import { agentPinsText } from "./agent-pins";
import { agentIdentityStyle } from "./agent-identity-color";
import { loopPhaseDelay } from "@/lib/motion-phase";
import { occupationLabels } from "./agent-occupation";
import { agentManagementPath } from "@/features/project-agents/orchestration-filters";
import type { ProjectAgentRecord } from "@/types";

const WORKING_RING_MS = 2400;

// One Agent in a collection. The name opens its profile; "quick look" (or a
// click on the card's empty surface) asks the collection for a Peek. The
// card lifts while its Peek is open, so the reader keeps their place.
const props = defineProps<{
  agent: ProjectAgentRecord;
  spaceId: string;
  projectNames?: Record<string, string>;
  managesAllProjects?: boolean;
  entry?: AgentWorkbenchEntry;
  pinned?: boolean;
  pinPending?: boolean;
  selected?: boolean;
}>();

const emit = defineEmits<{
  "toggle-pin": [pinned: boolean];
  peek: [];
}>();

const name = computed(() => agentDisplayName(props.agent));
// Fixed at mount: a re-created card resumes the shared ring cycle instead of restarting it.
const workingPhase = loopPhaseDelay(WORKING_RING_MS);
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
const now = useNow();
// Running time comes only from the recorded run start, never an update time.
const runningFor = computed(() =>
  workStatus.value === "running"
    ? formatElapsed(props.entry?.runningSince, currentLocale(), now.value)
    : null,
);
const taskLink = computed(() => ({
  path: agentManagementPath(props.spaceId, props.agent.agentId),
  query: { task: props.entry?.taskId ?? "" },
}));
const statusDetail = computed(() => workbenchStatusDetail(props.entry));
const occupation = computed(() => occupationLabels(props.agent.occupation));
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
const showsWorkStatus = computed(() =>
  workStatus.value !== "ended" && (props.agent.profile.status === "active" || !["none", "loading"].includes(workStatus.value)));
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
// The card's empty surface is a large mouse target for the quick look; links
// and buttons inside keep their own action, and selecting text does nothing.
function surfaceClick(event: MouseEvent) {
  if ((event.target as Element).closest("a, button, input, summary")) return;
  if (window.getSelection()?.toString()) return;
  emit("peek");
}
</script>

<template>
  <article
    class="agent-card group/card flex h-full min-w-0 cursor-pointer flex-col gap-2 rounded-lg border bg-card px-4 pt-3.5 pb-3 transition-[border-color,box-shadow] hover:border-border-strong"
    :class="{ 'is-selected border-border-strong shadow-md': selected }"
    :data-return-focus="agent.agentId"
    :data-selected="selected || undefined"
    @click="surfaceClick"
  >
    <div class="agent-card-topline flex items-start gap-3">
      <span
        class="agent-portrait small agent-card-identity"
        :class="{ 'is-working': workStatus === 'running' }"
        :style="[agentIdentityStyle(agent.agentId), { '--working-phase': workingPhase }]"
        aria-hidden="true"
        data-card-portrait
      >
        <img v-if="employeeAvatarUrl(agent.agentId)" :src="employeeAvatarUrl(agent.agentId)" alt="" />
        <template v-else>{{ agent.profile.occupationEmoji || name.slice(0, 1) }}</template>
      </span>
      <div class="min-w-0 flex-1">
        <div class="agent-directory-name flex min-w-0 items-start gap-1.5">
          <RouterLink
            class="agent-card-name"
            :to="agentProfilePath(spaceId, agent.agentId)"
            :title="name"
            :aria-label="`${name} · ${t('agentProfiles.profile')}`"
          >
            {{ name }}
          </RouterLink>
          <AgentHand :agent-id="agent.agentId" />
        </div>
        <p class="agent-card-tags mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span v-if="agent.employeeNumber" class="fla-employee-number whitespace-nowrap">FLA {{ agent.employeeNumber }}</span>
          <Badge v-if="fixedRole" class="agent-card-role">{{ fixedRole }}</Badge>
          <span
            v-if="occupation.length"
            class="agent-card-occupation min-w-0 truncate"
            data-occupation
            :title="t('agentRedesign.occupation.title')"
          >{{ occupation.join(" · ") }}</span>
          <span
            v-if="showsWorkStatus"
            class="agent-card-work-status"
            :class="workStatusClass"
            :data-work-status="workStatus"
            :aria-label="`${t('agentRedesign.workStatus.label')} · ${workStatusLabel}`"
          >
            <span class="agent-card-work-status-text">{{ workStatusLabel }}</span>
          </span>
          <span
            v-if="agent.profile.status !== 'active'"
            class="ui-badge agent-card-status agent-card-membership-status"
            :class="statusClass"
            :data-membership-status="agent.profile.status"
          >
            {{ membershipStatusLabel }}
          </span>
        </p>
      </div>
      <Button
        variant="outline"
        size="icon-sm"
        class="agent-card-pin"
        data-agent-pin-toggle
        :aria-label="`${pinLabel} · ${name}`"
        :aria-pressed="Boolean(pinned)"
        :title="pinLabel"
        :loading="pinPending"
        :loading-label="pinLabel"
        @click.stop="togglePin"
      >
        <PinIcon :filled="pinned" />
      </Button>
    </div>
    <p v-if="entry?.taskId" class="agent-card-current" data-current-task>
      <span class="agent-card-current-label">{{ t("agentRedesign.workbench.current") }}</span>
      <RouterLink class="agent-card-current-task" :to="taskLink" :class="{ 'is-unloaded': !entry.title }" :title="currentTaskTitle">
        {{ currentTaskTitle }}
      </RouterLink>
      <span
        v-if="workStatus === 'running'"
        class="agent-card-last-update"
        :title="entry.runningSince ?? undefined"
        data-running-since
      >
        {{ runningFor ? t("agentRedesign.workbench.runningFor", { duration: runningFor }) : t("agentRedesign.workbench.runningForUnknown") }}
      </span>
      <span v-else class="agent-card-last-update" :title="entry.lastUpdateAt ?? undefined" data-last-update>
        {{ lastUpdate ? t("agentRedesign.workbench.lastUpdate", { time: lastUpdate }) : t("agentRedesign.workbench.lastUpdateUnknown") }}
      </span>
    </p>
    <p v-if="statusDetail" class="agent-card-status-detail" :class="workStatusClass" :title="statusDetail" data-status-detail>{{ statusDetail }}</p>
    <p class="agent-card-responsibility" data-agent-summary :title="agentResponsibility(agent)">{{ agentResponsibility(agent) }}</p>
    <div v-if="capabilities.length" class="agent-inline-skills">
      <span v-for="skill in capabilities" :key="skill">{{ skill }}</span>
    </div>
    <div class="agent-card-meta mt-auto flex items-center justify-between gap-3 border-t pt-2.5">
      <div class="agent-card-projects min-w-0 flex-1">
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
      <Button
        variant="ghost"
        size="sm"
        class="agent-card-peek shrink-0"
        data-agent-peek
        :aria-label="t('agentProfiles.quickLookAgent', { name })"
        :aria-haspopup="'dialog'"
        @click.stop="emit('peek')"
      >
        {{ t("agentProfiles.quickLook") }}
      </Button>
    </div>
  </article>
</template>

<style scoped>
.agent-card-pin {
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
