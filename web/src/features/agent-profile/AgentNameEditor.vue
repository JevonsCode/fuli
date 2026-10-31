<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { apiErrorReason } from "@/api/client";
import GrowthLoading from "@/components/GrowthLoading.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";
import { UiIconButton } from "@/ui";
import { MAX_AGENT_NAME, freeNamesOffered, renameAgent } from "./agent-rename";
import { isBuiltInRole } from "./fla-mention";
import { agentDisplayName } from "./profile-model";

// The Agent's name, renamed where it stands (rec#11 D-89): the pencil turns
// the name into one line, Enter saves and Esc puts it back. A name another
// Agent uses is refused with free ones, each a click away. A built-in role
// renamed by the person can have its own name back; it answers to that name
// with `#FLA` either way.
const props = defineProps<{ agent: ProjectAgentRecord }>();
const emit = defineEmits<{ saved: [agent: ProjectAgentRecord] }>();

const editing = ref(false);
const draft = ref("");
const saving = ref<string | null>(null);
const error = ref("");
const freeNames = ref<string[]>([]);
const field = ref<InstanceType<typeof Input> | null>(null);

const shown = computed(() => agentDisplayName(props.agent));
const restorable = computed(() => isBuiltInRole(props.agent.agentId)
  && Boolean(props.agent.profile.displayName) && props.agent.profile.displayName !== props.agent.profile.name);
watch(() => props.agent.agentId, () => close());

function close() {
  editing.value = false;
  error.value = "";
  freeNames.value = [];
}

async function start() {
  draft.value = shown.value;
  error.value = "";
  freeNames.value = [];
  editing.value = true;
  await nextTick();
  const input = (field.value?.$el ?? null) as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

// One line: runs of spaces (and any line break a paste kept) become one space.
const cleaned = (value: string) => value.replace(/\s+/g, " ").trim();

async function save(next: string | null) {
  if (saving.value !== null) return;
  const name = next === null ? null : cleaned(next);
  if (name !== null && (!name || name === shown.value)) return close();
  saving.value = name ?? props.agent.profile.name;
  error.value = "";
  try {
    emit("saved", await renameAgent(props.agent, name));
    close();
  } catch (cause) {
    const offered = freeNamesOffered(cause);
    freeNames.value = offered ?? [];
    error.value = offered
      ? t("agentProfiles.name.taken", { name: saving.value })
      : t("agentProfiles.name.failed", { reason: apiErrorReason(cause) });
    if (name === null) editing.value = false;
  } finally {
    saving.value = null;
  }
}
</script>

<template>
  <div class="agent-name" data-agent-name>
    <div v-if="!editing" class="agent-name-row">
      <h1 class="agent-name-text">{{ shown }}</h1>
      <UiIconButton icon="edit" size="sm" class="agent-name-edit" :label="t('agentProfiles.name.edit', { name: shown })"
        data-agent-name-edit @click="start" />
      <Button v-if="restorable" variant="ghost" size="sm" class="agent-name-restore" :loading="saving !== null"
        :loading-label="t('agentProfiles.name.saving', { name: agent.profile.name })" data-agent-name-restore @click="save(null)">
        {{ t("agentProfiles.name.restore") }}
      </Button>
    </div>
    <form v-else class="agent-name-row" @submit.prevent="save(draft)">
      <Input ref="field" v-model="draft" class="agent-name-input" :maxlength="MAX_AGENT_NAME" :disabled="saving !== null"
        :aria-label="t('agentProfiles.name.label')" :aria-invalid="error ? true : undefined" autocomplete="off" enterkeyhint="done"
        data-agent-name-input @keydown.esc.prevent="close" />
      <GrowthLoading v-if="saving !== null" variant="inline" :label="t('agentProfiles.name.saving', { name: saving })" />
      <span v-else class="agent-name-keys" aria-hidden="true">{{ t("agentProfiles.name.keys") }}</span>
    </form>
    <p v-if="error" class="agent-name-error" role="alert">{{ error }}</p>
    <div v-if="freeNames.length" class="agent-name-free" data-agent-name-free>
      <span class="agent-name-free-label">{{ t("agentProfiles.name.free") }}</span>
      <Button v-for="name in freeNames" :key="name" variant="outline" size="sm" :disabled="saving !== null" @click="save(name)">{{ name }}</Button>
    </div>
  </div>
</template>

<style scoped>
.agent-name { display: grid; gap: 6px; min-width: 0; }
.agent-name-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; min-height: 36px; }
.agent-name-text { margin: 0; min-width: 0; color: var(--color-ink); font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-title); letter-spacing: -.02em; overflow-wrap: anywhere; }
/* The pencil stays quiet until the name is pointed at or reached by keyboard. */
.agent-name-edit { color: var(--color-ink-soft); opacity: .55; transition: opacity var(--motion-fast) var(--motion-ease); }
.agent-name-row:hover .agent-name-edit, .agent-name-edit:focus-visible { opacity: 1; }
.agent-name-restore { color: var(--color-ink-soft); }
.agent-name-input { flex: 0 1 22rem; height: 36px; font-size: var(--text-title); font-weight: var(--weight-strong); }
.agent-name-keys { color: var(--color-faint); font-size: var(--text-meta); }
.agent-name-error { margin: 0; color: var(--color-danger); font-size: var(--text-meta); }
.agent-name-free { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.agent-name-free-label { color: var(--color-ink-soft); font-size: var(--text-meta); }
@media (prefers-reduced-motion: reduce) { .agent-name-edit { transition: none; } }
</style>
