<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import GrowthLoading from "@/components/GrowthLoading.vue";
import PinIcon from "@/components/PinIcon.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { agentAvatarUrl } from "@/features/agent-profile/agent-avatar";
import { currentLocale, t } from "@/i18n";
import { formatElapsed } from "@/lib/elapsed-time";
import { useNow } from "@/composables/useNow";
import type { ProjectAgentRecord } from "@/types";
import { agentIdentityStyle } from "./agent-identity-color";
import { occupationLabels } from "./agent-occupation";
import { agentManagementPath } from "@/features/project-agents/orchestration-filters";
import { agentPinsText } from "./agent-pins";
import type { AgentWorkbenchEntry } from "./agent-workbench";
import { agentDisplayName, profileProjectIds } from "./profile-model";

// The quick look at one Agent: who it is, what it is doing now, where it
// works, and one quick change (pin). Everything else is on the full page.
// It renders inside the collection's Dialog, so the title is the dialog's name.
// A collection may name the projects itself (编排 counts policy membership)
// and put its own quick change in the actions slot instead of pin.
const props = defineProps<{
  state: "loading" | "error" | "unavailable" | "ready";
  error?: string;
  agent?: ProjectAgentRecord;
  entry?: AgentWorkbenchEntry;
  projectNames: Record<string, string>;
  projectLabels?: string[];
  managesAllProjects?: boolean;
  pinned?: boolean;
  pinPending?: boolean;
}>();
const emit = defineEmits<{ "toggle-pin": [pinned: boolean]; "open-full": []; retry: [] }>();

const name = computed(() => (props.agent ? agentDisplayName(props.agent) : ""));
const occupation = computed(() => occupationLabels(props.agent?.occupation));
const projects = computed(() => props.projectLabels
  ?? (props.agent ? profileProjectIds(props.agent) : []).map((id) => props.projectNames[id] || id));
const workStatus = computed(() => props.entry?.status ?? "unreported");
const workStatusLabel = computed(() => {
  const key = `agentRedesign.workStatus.${workStatus.value}`;
  const label = t(key);
  return label === key ? t("agentRedesign.workStatus.unreported") : label;
});
const now = useNow();
const runningFor = computed(() =>
  workStatus.value === "running" ? formatElapsed(props.entry?.runningSince, currentLocale(), now.value) : null,
);
const pinLabel = computed(() =>
  props.pinPending ? agentPinsText("saving", "Saving Agent pin…") : props.pinned ? agentPinsText("unpin", "Unpin Agent") : agentPinsText("pin", "Pin Agent"),
);
</script>

<template>
  <template v-if="state !== 'ready' || !agent">
    <DialogHeader>
      <DialogTitle>{{ t("agentProfiles.quickLook") }}</DialogTitle>
      <DialogDescription class="sr-only">{{ t("agentProfiles.peekLoading") }}</DialogDescription>
    </DialogHeader>
    <GrowthLoading v-if="state === 'loading'" variant="compact" :label="t('agentProfiles.peekLoading')" />
    <div v-else-if="state === 'error'" class="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive" role="alert">
      <p>{{ error || t("agentProfiles.loadError") }}</p>
      <Button variant="outline" size="sm" @click="emit('retry')">{{ t("agentProfiles.retry") }}</Button>
    </div>
    <p v-else class="text-sm text-muted-foreground" role="status">{{ t("agentProfiles.unavailable") }}</p>
  </template>
  <template v-else>
    <DialogHeader class="flex-row items-start gap-3">
      <span class="agent-portrait small agent-card-identity" :style="agentIdentityStyle(agent.agentId)" aria-hidden="true">
        <img :src="agentAvatarUrl(agent.agentId)" alt="" />
      </span>
      <div class="grid min-w-0 gap-1">
        <DialogTitle class="text-xl leading-tight [overflow-wrap:anywhere]">{{ name }}</DialogTitle>
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span v-if="agent.employeeNumber" class="whitespace-nowrap">FLA {{ agent.employeeNumber }}</span>
          <span v-if="occupation.length">{{ occupation.join(" · ") }}</span>
          <Badge :variant="agent.profile.status === 'active' ? 'success' : agent.profile.status === 'inactive' ? 'warning' : 'secondary'">
            {{ t(`projectAgents.status.${agent.profile.status}`) }}
          </Badge>
        </p>
      </div>
    </DialogHeader>
    <DialogDescription class="text-sm leading-relaxed text-foreground-soft [overflow-wrap:anywhere]">
      {{ agent.profile.responsibility || t("projectAgents.notReported") }}
    </DialogDescription>
    <dl class="agent-peek-facts m-0 grid gap-3 border-t pt-4 text-sm">
      <div class="grid gap-1">
        <dt class="text-xs font-semibold text-muted-foreground">{{ t("agentProfiles.working") }}</dt>
        <dd class="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span class="agent-card-work-status" :class="`is-${workStatus}`" :data-work-status="workStatus">
            <span class="agent-card-work-status-text">{{ workStatusLabel }}</span>
          </span>
          <RouterLink v-if="entry?.taskId" class="min-w-0 font-semibold text-foreground no-underline [overflow-wrap:anywhere] hover:text-primary hover:underline"
            :to="{ path: agentManagementPath(agent.personalSpaceId, agent.agentId), query: { task: entry.taskId } }">
            {{ entry.title ?? t("agentRedesign.workbench.titleNotLoaded") }}
          </RouterLink>
          <span v-if="runningFor" class="text-xs text-muted-foreground">{{ t("agentRedesign.workbench.runningFor", { duration: runningFor }) }}</span>
        </dd>
      </div>
      <div class="grid gap-1">
        <dt class="text-xs font-semibold text-muted-foreground">{{ t("agentProfiles.projects") }}</dt>
        <dd class="m-0 flex flex-wrap gap-1.5">
          <Badge v-for="project in projects" :key="project" variant="secondary" :title="project">{{ project }}</Badge>
          <Badge v-if="!projects.length && managesAllProjects" variant="secondary">{{ t("agentProfiles.allProjects") }}</Badge>
          <span v-else-if="!projects.length" class="text-muted-foreground">{{ t("agentProfiles.noProject") }}</span>
        </dd>
      </div>
      <div v-if="agent.profile.capabilities.length" class="grid gap-1">
        <dt class="text-xs font-semibold text-muted-foreground">{{ t("agentProfiles.strengths") }}</dt>
        <dd class="agent-inline-skills m-0">
          <span v-for="skill in agent.profile.capabilities" :key="skill">{{ skill }}</span>
        </dd>
      </div>
    </dl>
    <DialogFooter class="border-t pt-4">
      <slot name="actions">
        <Button
          variant="outline"
          data-peek-pin
          :aria-pressed="Boolean(pinned)"
          :loading="pinPending"
          :loading-label="pinLabel"
          @click="emit('toggle-pin', !pinned)"
        >
          <PinIcon :filled="pinned" class="size-4" />{{ pinLabel }}
        </Button>
      </slot>
      <Button data-peek-open-full @click="emit('open-full')">{{ t("agentProfiles.openFullPage") }}</Button>
    </DialogFooter>
  </template>
</template>
