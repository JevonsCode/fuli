<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { t } from "@/i18n";
import UiIcon from "@/ui/UiIcon.vue";
import { clipboardText, flaMention, mentionPhrasings } from "./fla-mention";

// Calls an FLA into a chat: one click copies `#FLA <name>` and says so;
// hovering or focusing the button shows ready-to-use phrasings, each copied
// with one click. `partner` is another FLA to name in the pair phrasing.
// `size` matches the buttons beside it (cards and quick look: sm; profile: default).
const props = withDefaults(
  defineProps<{ name: string; partner?: string | null; size?: "sm" | "default" }>(),
  { partner: null, size: "sm" },
);

const COPIED_MS = 1800;
const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 200;
// "mention" for the button, a phrasing key for a row, or null.
const copied = ref<string | null>(null);
const failed = ref(false);
let reset: ReturnType<typeof setTimeout> | undefined;

const mention = computed(() => flaMention(props.name));
const phrasings = computed(() =>
  mentionPhrasings(props.name, props.partner, (key, values) => t(`agentProfiles.mention.${key}`, values)),
);
const status = computed(() =>
  failed.value ? t("agentProfiles.mention.copyFailed") : copied.value ? t("agentProfiles.mention.copied") : "",
);

async function copy(id: string, text: string) {
  clearTimeout(reset);
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error("Clipboard unavailable");
    await clipboard.writeText(clipboardText(text));
    copied.value = id;
    failed.value = false;
  } catch {
    copied.value = null;
    failed.value = true;
  }
  reset = setTimeout(() => {
    copied.value = null;
    failed.value = false;
  }, COPIED_MS);
}
onBeforeUnmount(() => clearTimeout(reset));
</script>

<template>
  <span class="agent-mention">
    <HoverCard :open-delay="OPEN_DELAY_MS" :close-delay="CLOSE_DELAY_MS">
      <HoverCardTrigger as-child>
        <Button
          variant="outline"
          :size="size"
          class="agent-mention-copy"
          :class="{ 'is-copied': copied === 'mention' }"
          data-agent-mention-copy
          :aria-label="t('agentProfiles.mention.copyAgent', { mention })"
          @click="copy('mention', mention)"
        >
          <UiIcon :name="copied === 'mention' ? 'check' : 'copy'" :size="14" />
          {{ copied === "mention" ? t("agentProfiles.mention.copied") : t("agentProfiles.mention.copy") }}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" class="agent-mention-card p-3" style="width: min(340px, calc(100vw - 32px))" data-agent-mention-card>
        <p class="agent-mention-title">{{ t("agentProfiles.mention.title", { name }) }}</p>
        <ul class="agent-mention-list">
          <li v-for="item in phrasings" :key="item.key">
            <Button
              variant="ghost"
              class="agent-mention-phrasing"
              :class="{ 'is-copied': copied === item.key }"
              :data-mention-phrasing="item.key"
              :aria-label="t('agentProfiles.mention.copyPhrasing', { text: item.text })"
              @click="copy(item.key, item.text)"
            >
              <span class="agent-mention-text">{{ item.text }}<span v-if="item.open" class="agent-mention-rest" aria-hidden="true"> …</span></span>
              <span class="agent-mention-state">
                <span v-if="copied === item.key">{{ t("agentProfiles.mention.copied") }}</span>
                <UiIcon :name="copied === item.key ? 'check' : 'copy'" :size="14" />
              </span>
            </Button>
          </li>
        </ul>
        <p class="agent-mention-hint">{{ t("agentProfiles.mention.hint") }}</p>
      </HoverCardContent>
    </HoverCard>
    <span class="sr-only" role="status" aria-live="polite">{{ status }}</span>
  </span>
</template>

<style scoped>
.agent-mention { display: inline-flex; flex: 0 0 auto; }
.agent-mention-copy.is-copied,
.agent-mention-phrasing.is-copied .agent-mention-state { color: var(--color-success); }
.agent-mention-title { margin: 0 0 8px; color: var(--color-ink); font-size: 13px; font-weight: var(--weight-strong); line-height: 1.5; overflow-wrap: anywhere; }
.agent-mention-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.agent-mention-phrasing {
  width: 100%; height: auto; justify-content: space-between; gap: 10px; padding: 8px 10px;
  border: 1px solid var(--color-border); border-radius: var(--radius-control); background: var(--color-surface-subtle);
  color: var(--color-ink); text-align: left; white-space: normal;
}
.agent-mention-phrasing:hover:not(:disabled) { border-color: var(--color-border-strong); background: var(--color-surface-hover); }
.agent-mention-text { min-width: 0; font-family: var(--font-mono); font-size: 12px; font-weight: 500; line-height: 1.55; overflow-wrap: anywhere; }
.agent-mention-rest { color: var(--color-faint); }
.agent-mention-state { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; color: var(--color-muted); font-size: 12px; font-weight: var(--weight-medium); }
.agent-mention-hint { margin: 8px 0 0; color: var(--color-muted); font-size: 12px; line-height: 1.5; }
</style>
