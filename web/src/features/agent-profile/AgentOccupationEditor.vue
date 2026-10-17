<script setup lang="ts">
import { computed, ref, watch } from "vue";
import GrowthLoading from "@/components/GrowthLoading.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import { t } from "@/i18n";
import type { AgentOccupationKey, ProjectAgentRecord } from "@/types";
import {
  MAX_OCCUPATION_TAGS,
  OCCUPATION_KEYS,
  occupationLabel,
  saveAgentOccupation,
} from "./agent-occupation";

const props = defineProps<{ agent: ProjectAgentRecord }>();
const emit = defineEmits<{ saved: [agent: ProjectAgentRecord] }>();

const role = ref<AgentOccupationKey | "">("");
const tags = ref<AgentOccupationKey[]>([]);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

watch(() => props.agent.occupation, (occupation) => {
  role.value = occupation?.role ?? "";
  tags.value = [...(occupation?.tags ?? [])];
}, { immediate: true });

const roleOptions = computed(() => [
  { value: "", label: t("agentRedesign.occupation.none") },
  ...OCCUPATION_KEYS.map((key) => ({ value: key, label: occupationLabel(key) })),
]);

function toggleTag(key: AgentOccupationKey) {
  saved.value = false;
  tags.value = tags.value.includes(key)
    ? tags.value.filter((tag) => tag !== key)
    : [...tags.value, key];
}

async function save() {
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    const value = await saveAgentOccupation(props.agent.personalSpaceId, props.agent.agentId, {
      role: role.value || null,
      tags: tags.value,
    });
    emit("saved", value);
    saved.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("agentRedesign.occupation.saveError");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="agent-occupation-editor" data-occupation-editor @submit.prevent="save">
    <h3>{{ t("agentRedesign.occupation.title") }}</h3>
    <p class="ui-meta">{{ t("agentRedesign.occupation.note") }}</p>
    <UiSelect
      v-model="role"
      field
      :label="t('agentRedesign.occupation.role')"
      :options="roleOptions"
      :disabled="saving"
      @update:model-value="saved = false"
    />
    <fieldset class="agent-occupation-tags" :disabled="saving">
      <legend>
        {{ t("agentRedesign.occupation.tags") }}
        <small class="ui-meta">{{ t("agentRedesign.occupation.tagsHint") }}</small>
      </legend>
      <button
        v-for="key in OCCUPATION_KEYS"
        :key="key"
        type="button"
        class="quiet-button"
        :data-occupation-tag="key"
        :aria-pressed="tags.includes(key)"
        :disabled="!tags.includes(key) && tags.length >= MAX_OCCUPATION_TAGS"
        @click="toggleTag(key)"
      >
        {{ occupationLabel(key) }}
      </button>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="saved" role="status">{{ t("agentRedesign.occupation.saved") }}</p>
    <button class="primary-button" type="submit" :disabled="saving">
      <GrowthLoading
        v-if="saving"
        variant="inline"
        :label="t('agentRedesign.occupation.saving')"
      /><template v-else>{{ t("agentRedesign.occupation.save") }}</template>
    </button>
  </form>
</template>

<style scoped>
.agent-occupation-editor {
  display: grid;
  gap: var(--space-3, 12px);
}
.agent-occupation-editor h3,
.agent-occupation-editor p {
  margin: 0;
}
.agent-occupation-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
}
.agent-occupation-tags legend {
  margin-bottom: 6px;
  padding: 0;
  font-weight: 600;
}
.agent-occupation-tags button[aria-pressed="true"] {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
.agent-occupation-editor .primary-button {
  justify-self: start;
}
</style>
