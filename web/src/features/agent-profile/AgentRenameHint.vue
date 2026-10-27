<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { putJson } from "@/api/client";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";
import { agentDisplayName } from "./profile-model";

// A quiet, non-blocking offer for an Agent whose shown name reads as a job
// title ("PPT 专责"): one click gives it the free person-like name the
// Provider suggested. Nothing is renamed without that click; "keep" hides the
// offer for this visit.
const props = defineProps<{ agent: ProjectAgentRecord }>();
const emit = defineEmits<{ saved: [agent: ProjectAgentRecord] }>();

const kept = ref(false);
const saving = ref(false);
const error = ref("");
const suggestion = computed(() => props.agent.nameSuggestion ?? "");
watch(() => props.agent.agentId, () => { kept.value = false; error.value = ""; });

async function rename() {
  if (saving.value || !suggestion.value) return;
  const agent = props.agent;
  saving.value = true;
  error.value = "";
  try {
    emit("saved", await putJson<ProjectAgentRecord>("/api/project-agents", {
      personalSpaceId: agent.personalSpaceId,
      personalProjectId: null,
      agentId: agent.agentId,
      profile: { ...agent.profile, displayName: suggestion.value },
    }));
  } catch (cause) {
    error.value = t("agentProfiles.rename.failed", {
      reason: cause instanceof Error ? cause.message : t("agentProfiles.saveError"),
    });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section v-if="suggestion && !kept" class="agent-rename-hint" data-agent-rename-hint :aria-label="t('agentProfiles.rename.title')">
    <div class="agent-rename-copy">
      <h3>{{ t("agentProfiles.rename.title") }}</h3>
      <p>{{ t("agentProfiles.rename.body", { name: agentDisplayName(agent) }) }}</p>
      <p v-if="error" class="agent-rename-error" role="alert">{{ error }}</p>
    </div>
    <div class="agent-rename-actions">
      <Button
        size="sm"
        data-agent-rename-apply
        :loading="saving"
        :loading-label="t('agentProfiles.rename.saving', { name: suggestion })"
        @click="rename"
      >
        {{ t("agentProfiles.rename.apply", { name: suggestion }) }}
      </Button>
      <Button variant="ghost" size="sm" data-agent-rename-keep :disabled="saving" @click="kept = true">
        {{ t("agentProfiles.rename.keep") }}
      </Button>
    </div>
  </section>
</template>

<style scoped>
.agent-rename-hint {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px;
  padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface-subtle);
}
.agent-rename-copy { display: grid; flex: 1 1 320px; gap: 4px; min-width: 0; }
.agent-rename-copy h3 { margin: 0; color: var(--color-ink); font-size: 14px; font-weight: 650; }
.agent-rename-copy p { margin: 0; color: var(--color-ink-soft); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.agent-rename-copy .agent-rename-error { color: var(--color-danger); }
.agent-rename-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
