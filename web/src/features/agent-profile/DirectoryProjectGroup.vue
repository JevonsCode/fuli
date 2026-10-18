<script setup lang="ts">
import UiButton from '@/ui/UiButton.vue'
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";

import GrowthLoading from "@/components/GrowthLoading.vue";
import AgentName from "@/features/agent-profile/AgentName.vue";
import { occupationLabels } from "@/features/agent-profile/agent-occupation";
import { readProjectTeam, type ProjectTeam } from "@/features/projects/project-team-api";
import { personalProjectsPath } from "@/router/paths";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";

const props = defineProps<{
  spaceId: string;
  projectId: string | null;
  name: string;
  purpose?: string | null;
  agents?: readonly ProjectAgentRecord[];
  count: number;
  runningCount: number;
  unknownCount: number;
}>();
const expanded = defineModel<boolean>("expanded", { default: false });

// Full team details are read only when the project group is opened; collapsed
// headers summarize the lead and member occupations from the loaded roster.
const team = ref<ProjectTeam | null>(null);
const loading = ref(false);
const failed = ref(false);
let sequence = 0;

const panelId = computed(() => `directory-project-${props.projectId ?? "unassigned"}`);
const projectTo = computed(() => props.projectId && props.spaceId
  ? personalProjectsPath(props.spaceId, "overview", props.projectId)
  : null);

const headerLeadName = computed(() => {
  if (team.value?.lead?.name) return team.value.lead.name;
  const rosterLead = (props.agents ?? []).find(
    (agent) => agent.occupation?.role === "lead" || agent.profile.agentType === "coordinator",
  );
  return rosterLead ? (rosterLead.profile.displayName || rosterLead.profile.name) : null;
});

const memberOccupations = computed(() => {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const agent of props.agents ?? []) {
    const label = occupationLabels(agent.occupation)[0];
    if (!label) continue;
    const emoji = agent.profile.occupationEmoji?.trim();
    const token = emoji ? `${emoji} ${label}` : label;
    if (!seen.has(token)) {
      seen.add(token);
      items.push(token);
    }
  }
  return items;
});

async function loadTeam() {
  if (!props.projectId || !props.spaceId) return;
  const current = ++sequence;
  loading.value = true;
  failed.value = false;
  try {
    const value = await readProjectTeam(props.spaceId, props.projectId);
    if (current === sequence) team.value = value;
  } catch {
    if (current === sequence) failed.value = true;
  } finally {
    if (current === sequence) loading.value = false;
  }
}

watch(() => [props.spaceId, props.projectId], () => {
  sequence += 1;
  team.value = null;
  loading.value = false;
  failed.value = false;
  if (expanded.value) void loadTeam();
});
watch(expanded, (open) => {
  if (open && !team.value && !loading.value) void loadTeam();
}, { immediate: true });
</script>

<template>
  <section class="directory-project" :data-directory-project="projectId ?? ''">
    <button
      type="button"
      class="directory-project-toggle"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      @click="expanded = !expanded"
    >
      <span class="directory-project-heading">
        <span class="directory-project-name">{{ name }}</span>
        <span v-if="purpose" class="ui-meta directory-project-purpose" data-project-purpose>{{ purpose }}</span>
      </span>
      <span class="ui-meta directory-project-summary">
        <span class="directory-project-header-lead" data-project-header-lead>
          {{ headerLeadName ? t("agentRedesign.projectView.lead", { name: headerLeadName }) : t("agentRedesign.projectView.leadUnset") }}
        </span>
        <span v-if="memberOccupations.length" class="directory-project-occupations" data-project-member-occupations>
          · {{ memberOccupations.join(" · ") }}
        </span>
      </span>
      <span class="ui-meta directory-project-counts">
        {{ t("agentRedesign.projectView.members", { count }) }}
        <template v-if="runningCount"> · {{ t("agentRedesign.projectView.running", { count: runningCount }) }}</template>
        <template v-if="unknownCount"> · {{ t("agentRedesign.projectView.unknown", { count: unknownCount }) }}</template>
      </span>
      <svg class="directory-project-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div v-if="expanded" :id="panelId" class="directory-project-body">
      <div v-if="projectId" class="directory-project-lead" data-project-lead>
        <GrowthLoading
          v-if="loading"
          variant="inline"
          :label="t('agentRedesign.projectView.loadingLead')"
        />
        <p v-else-if="failed" role="alert">
          {{ t("agentRedesign.projectView.leadFailed") }}
          <UiButton size="sm" variant="ghost" @click="loadTeam">
            {{ t("agentProfiles.retry") }}
          </UiButton>
        </p>
        <p v-else-if="team?.lead">
          <span class="ui-meta">{{ t("projects.overview.lead") }}</span>
          <AgentName :space-id="spaceId" :agent-id="team.lead.agentId" :name="team.lead.name" />
        </p>
        <p v-else-if="team" class="ui-meta">
          {{ team.status === "lead_unavailable"
            ? t("projects.overview.leadUnavailableUnnamed")
            : t("projects.overview.noLead") }}
        </p>
        <RouterLink v-if="projectTo" class="quiet-button" :to="projectTo">
          {{ t("agentRedesign.projectView.openProject") }}
        </RouterLink>
      </div>
      <slot />
    </div>
  </section>
</template>
