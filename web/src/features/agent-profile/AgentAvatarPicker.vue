<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { apiErrorReason } from "@/api/client";
import GrowthLoading from "@/components/GrowthLoading.vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { UiIcon } from "@/ui";
import { agentAvatarUrl, generatedAvatarUrl } from "./agent-avatar";
import { agentLooks, saveAgentLook, type LookChoice } from "./agent-looks";
import { AVATAR_TYPES, AvatarImageError, scaleAvatarImage } from "./avatar-image";

// The Agent's portrait, which the person can change (rec#11 D-89): another
// drawing, a picture of their own, or back to the default. A new drawing or
// picture is shown first and saved only with 「用这个」. The look is the
// person's choice on this computer; no Agent can change it.
const props = defineProps<{ agentId: string; spaceId: string; name: string }>();

const open = ref(false);
const candidate = ref<{ look: LookChoice; url: string } | null>(null);
const saving = ref(false);
const reading = ref(false);
const error = ref("");
const file = ref<HTMLInputElement | null>(null);

const current = computed(() => agentAvatarUrl(props.agentId));
const preview = computed(() => candidate.value?.url ?? current.value);
const changed = computed(() => agentLooks.value.has(props.agentId));
watch(open, (value) => { if (!value) { candidate.value = null; error.value = ""; } });
watch(() => props.agentId, () => { open.value = false; });

function reroll() {
  const seed = crypto.randomUUID();
  candidate.value = { look: { kind: "generated", seed }, url: generatedAvatarUrl(seed) };
  error.value = "";
}

const IMAGE_ERRORS = { type: "agentProfiles.look.type", unreadable: "agentProfiles.look.unreadable", too_large: "agentProfiles.look.tooLarge" } as const;

async function picked(event: Event) {
  const input = event.target as HTMLInputElement;
  const chosen = input.files?.[0];
  input.value = "";
  if (!chosen) return;
  reading.value = true;
  error.value = "";
  try {
    const data = await scaleAvatarImage(chosen);
    candidate.value = { look: { kind: "image", data }, url: `data:image/webp;base64,${data}` };
  } catch (cause) {
    error.value = t(cause instanceof AvatarImageError ? IMAGE_ERRORS[cause.reason] : "agentProfiles.look.unreadable");
  } finally {
    reading.value = false;
  }
}

async function save(look: LookChoice) {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await saveAgentLook(props.spaceId, props.agentId, look);
    open.value = false;
  } catch (cause) {
    error.value = t("agentProfiles.look.failed", { reason: apiErrorReason(cause) });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="ghost" class="agent-look-trigger" :aria-label="t('agentProfiles.look.change', { name })" data-agent-look-trigger>
        <span class="agent-look-frame" aria-hidden="true">
          <Transition name="agent-look-fade"><img :key="current" :src="current" alt="" /></Transition>
        </span>
        <span class="agent-look-badge" aria-hidden="true"><UiIcon name="edit" :size="12" /></span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :aria-label="t('agentProfiles.look.title', { name })" data-agent-look-panel>
      <!-- The panel itself is portalled outside this component's scoped styles; its body is not. -->
      <div class="agent-look-panel">
        <span class="agent-look-preview" aria-hidden="true">
          <Transition name="agent-look-fade"><img :key="preview" :src="preview" alt="" /></Transition>
        </span>
        <p v-if="candidate" class="agent-look-note">{{ t("agentProfiles.look.previewing") }}</p>
        <GrowthLoading v-if="saving" variant="inline" :label="t('agentProfiles.look.saving', { name })" />
        <GrowthLoading v-else-if="reading" variant="inline" :label="t('agentProfiles.look.reading')" />
        <p v-if="error" class="agent-look-error" role="alert">{{ error }}</p>
        <div v-if="candidate" class="agent-look-actions">
          <Button size="sm" :disabled="saving" data-agent-look-use @click="save(candidate.look)">{{ t("agentProfiles.look.use") }}</Button>
          <Button v-if="candidate.look.kind === 'generated'" variant="outline" size="sm" :disabled="saving" data-agent-look-again @click="reroll">
            {{ t("agentProfiles.look.again") }}
          </Button>
          <Button variant="ghost" size="sm" :disabled="saving" data-agent-look-cancel @click="candidate = null">{{ t("agentProfiles.look.cancel") }}</Button>
        </div>
        <div v-else class="agent-look-actions is-stacked">
          <Button variant="outline" size="sm" :disabled="saving || reading" data-agent-look-reroll @click="reroll">{{ t("agentProfiles.look.reroll") }}</Button>
          <Button variant="outline" size="sm" :disabled="saving || reading" data-agent-look-upload @click="file?.click()">{{ t("agentProfiles.look.upload") }}</Button>
          <Button v-if="changed" variant="ghost" size="sm" :disabled="saving || reading" data-agent-look-reset @click="save({ kind: 'default' })">
            {{ t("agentProfiles.look.reset") }}
          </Button>
          <input ref="file" class="sr-only" type="file" :accept="AVATAR_TYPES.join(',')" tabindex="-1" aria-hidden="true" data-agent-look-file @change="picked" />
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
/* The trigger is the portrait itself; its size comes from the page's portrait class. */
.agent-look-trigger { position: relative; display: block; width: 100%; height: 100%; padding: 0; border: 0; border-radius: inherit; background: none; }
.agent-look-trigger:hover:not(:disabled) { background: none; }
.agent-look-frame, .agent-look-preview { position: relative; display: block; overflow: hidden; border-radius: inherit; }
.agent-look-frame { width: 100%; height: 100%; }
/* Both pictures sit in one frame while one fades into the other, so nothing moves. */
.agent-look-frame img, .agent-look-preview img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.agent-look-badge {
  position: absolute; right: -2px; bottom: -2px; display: grid; width: 22px; height: 22px; place-items: center; border-radius: 50%;
  color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border);
  opacity: 0; transform: scale(.8); transition: opacity var(--motion-fast) var(--motion-ease), transform var(--motion-fast) var(--motion-ease);
}
.agent-look-trigger:hover .agent-look-badge, .agent-look-trigger:focus-visible .agent-look-badge, .agent-look-trigger[data-state="open"] .agent-look-badge { opacity: 1; transform: none; }
.agent-look-panel { display: grid; justify-items: center; gap: 10px; width: 208px; }
.agent-look-preview { width: 96px; height: 96px; border-radius: 50%; background: var(--color-surface-subtle); }
.agent-look-note { margin: 0; color: var(--color-ink-soft); font-size: var(--text-meta); }
.agent-look-error { margin: 0; color: var(--color-danger); font-size: var(--text-meta); text-align: center; }
.agent-look-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; width: 100%; }
/* One full-width button per row, like an action list. */
.agent-look-actions.is-stacked { display: grid; justify-content: stretch; }
.agent-look-fade-enter-active, .agent-look-fade-leave-active { transition: opacity var(--motion-enter); }
.agent-look-fade-enter-from, .agent-look-fade-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .agent-look-badge, .agent-look-fade-enter-active, .agent-look-fade-leave-active { transition: none; }
}
:root[data-motion="reduced"] :is(.agent-look-badge, .agent-look-fade-enter-active, .agent-look-fade-leave-active) { transition: none; }
</style>
