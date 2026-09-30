<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getJson, putJson } from "@/api/client";
import GrowthLoading from "@/components/GrowthLoading.vue";
import { t } from "@/i18n";
import type { ProjectAgentRecord, ProjectAgentExecutorRef } from "@/types";
const props = defineProps<{ agent: ProjectAgentRecord }>();
const emit = defineEmits<{ saved: [agent: ProjectAgentRecord] }>();
const executors = ref<ProjectAgentExecutorRef[]>([]);
const loading = ref(false),
  saving = ref(false),
  error = ref(""),
  saved = ref(false);
let originalPlatform = "";
const platform = ref(""),
  expectations = ref("");
const character = ref({ judgment: "", taste: "", personality: "" });
const locked = computed(
  () => props.agent.profile.executorPolicy?.mode === "locked",
);
const lockedPlatforms = computed(() => {
  const policy = props.agent.profile.executorPolicy;
  const ids = policy?.lockedExecutorIds?.length
    ? policy.lockedExecutorIds
    : (policy?.allowList ?? []).map((item) => item.executorId);
  return ids.map(
    (id) =>
      executors.value.find((item) => item.executorId === id)?.displayName || id,
  );
});
const options = computed(() =>
  executors.value.filter(
    (item) =>
      item.registrationStatus === "registered" &&
      item.permissionStatus === "authorized" &&
      item.preflightStatus === "passed" &&
      item.workspacePermission &&
      item.healthStatus !== "unhealthy" &&
      (!item.healthRequired || item.healthStatus === "healthy"),
  ),
);
let generation = 0;
watch(
  () => `${props.agent.personalSpaceId}/${props.agent.agentId}`,
  async () => {
    const agent = props.agent;
    const current = ++generation;
    expectations.value = agent.profile.expectations ?? "";
    character.value = {
      judgment: "",
      taste: "",
      personality: "",
      ...agent.profile.character,
    };
    platform.value =
      agent.profile.executorPolicy?.preferredExecutorIds?.[0] ?? "";
    originalPlatform = platform.value;
    error.value = "";
    saved.value = false;
    saving.value = false;
    loading.value = true;
    executors.value = [];
    try {
      const value = await getJson<
        ProjectAgentExecutorRef[] | { executors: ProjectAgentExecutorRef[] }
      >(
        `/api/executors?${new URLSearchParams({ personalSpaceId: agent.personalSpaceId })}`,
      );
      if (current === generation)
        executors.value = Array.isArray(value) ? value : value.executors;
    } catch {
      if (current === generation)
        error.value = t("agentProfiles.platformUnavailable");
    } finally {
      if (current === generation) loading.value = false;
    }
  },
  { immediate: true },
);
async function save() {
  if (saving.value) return;
  const current = generation;
  const agent = props.agent;
  saving.value = true;
  error.value = "";
  saved.value = false;
  const policy = agent.profile.executorPolicy;
  try {
    const value = await putJson<ProjectAgentRecord>("/api/project-agents", {
      personalSpaceId: agent.personalSpaceId,
      personalProjectId: agent.personalProjectId ?? null,
      agentId: agent.agentId,
      profile: {
        ...agent.profile,
        character: { ...character.value },
        expectations: expectations.value,
        executorPolicy:
          locked.value || platform.value === originalPlatform
            ? policy
            : {
                ...policy,
                mode: "flexible",
                preferredExecutorIds: platform.value ? [platform.value] : [],
              },
      },
    });
    if (current === generation) {
      originalPlatform = platform.value;
      emit("saved", value);
      saved.value = true;
    }
  } catch (cause) {
    if (current === generation)
      error.value =
        cause instanceof Error ? cause.message : t("agentProfiles.saveError");
  } finally {
    if (current === generation) saving.value = false;
  }
}
</script>
<template>
  <form class="agent-simple-settings" @submit.prevent="save">
    <h3>{{ t("agentProfiles.settings") }}</h3>
    <GrowthLoading
      v-if="loading"
      variant="compact"
      :label="t('agentProfiles.settingsLoading')"
    />
    <div v-else-if="locked" class="agent-locked-platforms">
      <h4>{{ t("agentProfiles.platform") }}</h4>
      <p>
        {{
          lockedPlatforms.join(" · ") || t("agentProfiles.platformUnavailable")
        }}
      </p>
      <small>{{ t("agentProfiles.locked") }}</small>
    </div>
    <label v-else
      >{{ t("agentProfiles.platform")
      }}<select v-model="platform" :disabled="locked || saving">
        <option value="">{{ t("agentProfiles.automatic") }}</option>
        <option
          v-if="
            platform && !options.some((item) => item.executorId === platform)
          "
          :value="platform"
          disabled
        >
          {{ t("agentProfiles.platformUnavailable") }}
        </option>
        <option
          v-for="executor in options"
          :key="executor.executorId"
          :value="executor.executorId"
        >
          {{ executor.displayName || executor.executorId }}
        </option></select
      ><small>{{
        t(locked ? "agentProfiles.locked" : "agentProfiles.platformHint")
      }}</small></label
    >
    <label
      >{{ t("agentProfiles.expectations")
      }}<textarea
        v-model="expectations"
        rows="3"
        maxlength="4096"
        :disabled="saving"
        :placeholder="t('agentProfiles.expectationsPlaceholder')"
      />
    </label>
    <details>
      <summary>{{ t("agentProfiles.editCharacter") }}</summary>
      <label
        v-for="key in ['judgment', 'taste', 'personality'] as const"
        :key="key"
        >{{ t(`agentProfiles.${key}`)
        }}<textarea
          v-model="character[key]"
          rows="2"
          maxlength="2048"
          :disabled="saving"
        />
      </label>
    </details>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="saved" role="status">{{ t("agentProfiles.saved") }}</p>
    <button class="primary-button" :disabled="saving || loading" type="submit">
      <GrowthLoading
        v-if="saving"
        variant="inline"
        :label="t('agentProfiles.saving')"
      /><template v-else>{{ t("agentProfiles.save") }}</template>
    </button>
  </form>
</template>
