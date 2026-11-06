<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useClipboardCopy } from '@/composables/useClipboardCopy'
import { t } from '@/i18n'
import { formatBytes } from '@/lib/format-bytes'
import { UiIcon } from '@/ui'
import { partIsLong, partTitle, sourceColour, type DebugPart } from './model'

// One part of a #fulidebug turn record, tinted by its source. It shows two lines at
// most, never wider than the page; 「查看详情」 opens the whole text in a large
// dialog that scrolls (Jevons 11-04).
const props = defineProps<{ part: DebugPart }>()
const { copied, failed, copy } = useClipboardCopy()
const title = computed(() => partTitle(props.part))
const preview = ref<HTMLElement | null>(null)
const clipped = ref(false)
useResizeObserver(preview, () => {
  const element = preview.value
  clipped.value = Boolean(element) && element!.scrollHeight > element!.clientHeight + 1
})
const hasMore = computed(() => clipped.value || partIsLong(props.part))
const open = ref(false)
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
    <p v-if="part.text" ref="preview" class="debug-part-preview" data-debug-part-preview>{{ part.text }}</p>
    <Button v-if="hasMore" type="button" size="sm" variant="ghost" class="debug-part-more" aria-haspopup="dialog" data-debug-part-more @click="open = true">
      {{ t('debugTurns.details') }}
    </Button>
    <Dialog v-model:open="open">
      <DialogContent class="debug-part-dialog" data-debug-part-dialog>
        <DialogHeader><DialogTitle>{{ title }}</DialogTitle></DialogHeader>
        <pre class="debug-part-full">{{ part.text }}</pre>
      </DialogContent>
    </Dialog>
  </article>
</template>

<style scoped>
/* The source shows as a tint and the dot in the heading, never a side bar. */
.debug-part { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--source) 28%, var(--color-border));
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
.debug-part-preview { display: -webkit-box; margin: 0; overflow: hidden; font-family: var(--font-mono, monospace); font-size: var(--text-meta); line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
.debug-part-more { justify-self: start; }
.debug-part-full { max-height: calc(100dvh - 180px); margin: 0; overflow: auto; font-size: var(--text-meta); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>

<style>
/* The dialog renders outside this component, and the text wants the room. */
[data-slot="dialog-content"].debug-part-dialog { max-width: min(1100px, calc(100% - 32px)); }
</style>
