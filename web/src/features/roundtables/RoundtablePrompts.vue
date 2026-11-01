<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useClipboardCopy } from '@/composables/useClipboardCopy'
import { clipboardText, conversationPhrasings, type MentionPhrasing } from '@/features/agent-profile/fla-mention'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'

// How Agents start talking: people do not open conversations here, their
// Agents do. The helper offers what to paste into the person's own Agent chat,
// in the syntax task entry parses (@FLG, #FLA; rec#54, rec#55), each copied with
// one click. `names` are two of the person's FLAs for the examples that name them.
const props = defineProps<{ names: readonly string[]; compact?: boolean }>()

const examples = computed(() => conversationPhrasings(props.names, (key, values) => t(`agentProfiles.mention.${key}`, values)))
const { copied, failed, copy } = useClipboardCopy()
const copyExample = (item: MentionPhrasing) => copy(item.key, clipboardText(item.text))
const status = computed(() => failed.value ? t('agentProfiles.mention.copyFailed') : copied.value ? t('agentProfiles.mention.copied') : '')
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button variant="ghost" :size="compact ? 'icon-sm' : 'sm'" class="rt-prompts-trigger"
        :aria-label="compact ? t('roundtable.prompts.open') : undefined" :title="compact ? t('roundtable.prompts.open') : undefined" data-roundtable-prompts>
        <UiIcon name="roundtable" :size="16" />
        <span v-if="!compact">{{ t('roundtable.prompts.open') }}</span>
      </Button>
    </PopoverTrigger>
    <!-- The panel is portalled outside this component's scoped styles; its body carries the glass. -->
    <PopoverContent align="start" class="w-auto border-0 bg-transparent p-0 shadow-none" :aria-label="t('roundtable.prompts.open')" data-roundtable-prompts-panel>
      <div class="rt-prompts">
        <p class="rt-prompts-hint">{{ t('roundtable.prompts.hint') }}</p>
        <ul class="rt-prompts-list">
          <li v-for="item in examples" :key="item.key">
            <Button variant="ghost" class="rt-prompt" :class="{ 'is-copied': copied === item.key }" :data-roundtable-prompt="item.key"
              :aria-label="t('agentProfiles.mention.copyPhrasing', { text: item.text })" @click="copyExample(item)">
              <span class="rt-prompt-text">
                <code>{{ item.text }}<span v-if="item.open" class="rt-prompt-rest" aria-hidden="true"> …</span></code>
                <small>{{ t(`roundtable.prompts.${item.key}`) }}</small>
              </span>
              <span class="rt-prompt-state" aria-hidden="true">
                <UiIcon :name="copied === item.key ? 'check' : 'copy'" :size="14" />
              </span>
            </Button>
          </li>
        </ul>
        <p v-if="failed" class="rt-prompts-failed" role="alert">{{ t('agentProfiles.mention.copyFailed') }}</p>
        <span class="ui-sr-only" role="status" aria-live="polite">{{ failed ? '' : status }}</span>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.rt-prompts-trigger { user-select: none; }
/* Frosted glass like the dock: the glass on its own layer, so the panel blurs the page beneath it. */
.rt-prompts {
  position: relative; isolation: isolate; display: grid; gap: 10px; width: min(360px, calc(100vw - 32px)); padding: 12px;
  border: 1px solid var(--edge-dock); border-radius: var(--radius-card); box-shadow: var(--shadow-glass);
}
.rt-prompts::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  background: var(--glass-sheen), var(--surface-dock-panel); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .rt-prompts::before { background: var(--color-surface); }
}
.rt-prompts-hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); line-height: 1.5; }
.rt-prompts-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.rt-prompt {
  display: grid; grid-template-columns: minmax(0, 1fr) 16px; align-items: center; gap: 10px; width: 100%; height: auto; padding: 8px 10px;
  border: 1px solid var(--edge-glass); border-radius: var(--radius-control); background: var(--surface-glass-strong);
  color: var(--color-ink); text-align: left; white-space: normal; user-select: none;
}
.rt-prompt-text { display: grid; gap: 2px; min-width: 0; }
.rt-prompt-text code { font-family: var(--font-mono); font-size: var(--text-meta); font-weight: var(--weight-medium); line-height: 1.55; overflow-wrap: anywhere; }
.rt-prompt-text small { color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular); }
.rt-prompt-rest { color: var(--color-faint); }
.rt-prompt-state { display: grid; place-items: center; color: var(--color-muted); }
.rt-prompt.is-copied .rt-prompt-state { color: var(--color-success); }
.rt-prompts-failed { margin: 0; color: var(--color-danger); font-size: var(--text-meta); }
</style>
