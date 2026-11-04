<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useClipboardCopy } from '@/composables/useClipboardCopy'
import { t } from '@/i18n'
import { formatBytes } from '@/lib/format-bytes'
import { UiIcon } from '@/ui'
import { partTitle, sourceColour, startsFolded, type DebugPart } from './model'

// One part of a #debug turn record, marked by its source's colour. A long part
// starts folded; the copy button sits outside the fold, so it never moves.
const props = defineProps<{ part: DebugPart }>()
const { copied, failed, copy } = useClipboardCopy()
const title = computed(() => partTitle(props.part))
const folded = computed(() => startsFolded(props.part))
const copyLabel = computed(() => failed.value ? t('debugTurns.copyFailed') : copied.value ? t('debugTurns.copied') : t('debugTurns.copy'))
</script>

<template>
  <article class="debug-part" :data-source="part.source" :style="{ '--source': sourceColour(part.source) }" data-debug-part>
    <header class="debug-part-head">
      <span class="debug-part-swatch" aria-hidden="true" />
      <span class="debug-part-title">{{ title }}</span>
      <span class="debug-part-meta">{{ t(`debugTurns.sources.${part.source}`) }} · {{ formatBytes(part.bytes) }}</span>
      <Button type="button" size="sm" variant="ghost" class="debug-part-copy" data-debug-part-copy @click="copy('part', part.text)">
        <UiIcon :name="copied ? 'check' : 'copy'" :size="14" aria-hidden="true" />
        <span class="debug-part-copy-labels">
          <span :class="{ 'is-shown': !copied && !failed }">{{ t('debugTurns.copy') }}</span>
          <span :class="{ 'is-shown': copied }">{{ t('debugTurns.copied') }}</span>
          <span :class="{ 'is-shown': failed }">{{ t('debugTurns.copyFailed') }}</span>
        </span>
        <span class="sr-only" role="status">{{ copied || failed ? copyLabel : '' }}</span>
      </Button>
    </header>
    <details v-if="folded" class="debug-part-fold" data-debug-part-folded>
      <summary>{{ part.text.split('\n', 1)[0] }}</summary>
      <pre>{{ part.text }}</pre>
    </details>
    <pre v-else>{{ part.text }}</pre>
  </article>
</template>

<style scoped>
/* The source shows as a tint and the dot in the heading, never a side bar. */
.debug-part { display: grid; gap: 6px; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--source) 28%, var(--color-border));
  border-radius: var(--radius-control); background: color-mix(in srgb, var(--source) 7%, var(--color-surface)); }
.debug-part[data-source="not_visible"] { border-style: dashed; }
.debug-part-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.debug-part-swatch { flex: none; width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--source); }
.debug-part-title { min-width: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.debug-part-meta { flex: none; color: var(--color-muted); font-size: var(--text-meta); }
.debug-part-copy { flex: none; margin-left: auto; }
/* Every label sits in the same cell; only the current one shows, so the button keeps its width. */
.debug-part-copy-labels { display: grid; }
.debug-part-copy-labels > span { grid-area: 1 / 1; visibility: hidden; }
.debug-part-copy-labels > .is-shown { visibility: visible; }
.debug-part-fold summary { overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.debug-part pre { max-height: 480px; margin: 0; overflow: auto; font-size: var(--text-meta); white-space: pre-wrap; overflow-wrap: anywhere; }
.debug-part-fold[open] summary { margin-bottom: 6px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
