<script setup lang="ts">
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import { ICON_GLYPH, type ControlSize } from '@/components/ui/control-size'
import { t } from '@/i18n'
import UiIcon from './UiIcon.vue'

// The one entry to a prompt for the person's own AI (Jevons 11-11): a blue
// spark, the size of the round icon buttons beside it. Every place that opens
// 「让 AI 来做」 or hands a prompt to an AI uses this; a 「?」 only explains a
// word. Blue is the AI's colour here, apart from the brand's gold. The area
// is required: the accessible name and the tooltip say 「让 AI 来做：<area>」.
const props = withDefaults(defineProps<{ area: string; size?: ControlSize; active?: boolean }>(), { size: 'sm', active: false })
const label = computed(() => t('aiHelp.entry', { area: props.area }))
</script>

<template>
  <Button variant="ghost" :size="`icon-${size}`" class="ui-ai-button rounded-full transition-[color,background-color,scale] active:not-disabled:scale-94"
    :aria-label="label" :title="label" :aria-pressed="active || undefined" data-ai-entry>
    <UiIcon name="ai" :size="ICON_GLYPH[size]" />
  </Button>
</template>

<style scoped>
.ui-ai-button { color: var(--color-ai); user-select: none; }
.ui-ai-button:hover:not(:disabled), .ui-ai-button:focus-visible, .ui-ai-button[aria-pressed="true"] { background: var(--color-ai-soft); color: var(--color-ai); }
/* The spark is a filled mark, not a line drawing. */
.ui-ai-button :deep(.ui-icon) { fill: currentColor; stroke-width: 1; }
</style>
