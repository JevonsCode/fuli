<script setup lang="ts">
import { computed } from 'vue'
import { useClipboardCopy } from '@/composables/useClipboardCopy'
import { t } from '@/i18n'
import UiIconButton from '@/ui/UiIconButton.vue'
import UiNotice from '@/ui/UiNotice.vue'
import { shownText } from './visit-request-model'
import type { VisitRequestCard } from './visit-request-shape'
import './visit-card.css'

// What a finished run left: the assistant's summary, the branch (with a copy
// button), each changed file with its added and removed lines, and the diff as
// monospaced text that scrolls in its own box, so the card never grows sideways.
// A held result says why in plain words and that nothing went to the other computer.
const props = defineProps<{ card: VisitRequestCard }>()
const clipboard = useClipboardCopy()
const result = computed(() => props.card.result)
const files = computed(() => result.value?.files ?? [])
</script>

<template>
  <section class="visit-section" data-visit-review-section :aria-label="t('visitRequests.result.title')">
    <h3 class="ui-group-label">{{ t('visitRequests.result.title') }}</h3>
    <UiNotice v-if="card.review === 'held' && card.holdReason" tone="warning" data-visit-held>
      <span class="visit-held-line">{{ t(`visitRequests.result.held.${card.holdReason}`) }}</span>
      <span class="visit-held-line">{{ t('visitRequests.result.nothingSent') }}</span>
    </UiNotice>
    <p class="visit-text" data-visit-summary>{{ result?.summary ? shownText(result.summary) : t('visitRequests.result.noSummary') }}</p>
    <div v-if="result?.branch" class="visit-branch">
      <span class="visit-label">{{ t('visitRequests.result.branch') }}</span>
      <code data-visit-branch>{{ result.branch }}</code>
      <UiIconButton icon="copy" size="sm" :label="t('visitRequests.result.copy')" data-visit-copy-branch
        @click="clipboard.copy('branch', result.branch)" />
      <!-- Reserved width: the line keeps its place when the word appears. -->
      <span class="visit-copied" role="status">{{ clipboard.copied.value ? t('visitRequests.result.copied')
        : clipboard.failed.value ? t('visitRequests.result.copyFailed') : '' }}</span>
    </div>
    <template v-if="files.length">
      <h4 class="ui-group-label">{{ t('visitRequests.result.files', { count: files.length }) }}</h4>
      <ul class="visit-files" data-visit-files>
        <li v-for="file in files" :key="file.path">
          <code :title="file.path">{{ file.path }}</code>
          <span class="visit-added">+{{ file.added }}</span>
          <span class="visit-removed">−{{ file.removed }}</span>
        </li>
      </ul>
    </template>
    <h4 class="ui-group-label">{{ t('visitRequests.result.diff') }}</h4>
    <template v-if="card.diff">
      <pre class="visit-diff" tabindex="0" :aria-label="t('visitRequests.result.diff')" data-visit-diff>{{ card.diff.text }}</pre>
      <p v-if="card.diff.truncated" class="visit-note" data-visit-truncated>{{ t('visitRequests.result.truncated') }}</p>
    </template>
    <p v-else class="visit-note">{{ t('visitRequests.result.noDiff') }}</p>
  </section>
</template>

<style scoped>
.visit-held-line { display: block; }
.visit-branch { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 30px; }
.visit-branch code { min-width: 0; overflow: hidden; font: var(--text-meta) / 1.5 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.visit-label { flex: none; color: var(--color-muted); font-size: var(--text-meta); }
.visit-copied { min-width: 6em; color: var(--color-muted); font-size: var(--text-meta); }
.visit-files { display: grid; margin: 0; padding: 0; list-style: none; }
.visit-files li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 10px; min-height: 26px; font-size: var(--text-meta); }
.visit-files code { overflow: hidden; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.visit-added, .visit-removed { font-variant-numeric: tabular-nums; }
.visit-added { color: var(--color-success); }
.visit-removed { color: var(--color-destructive); }
.visit-diff {
  max-width: 100%; max-height: 320px; margin: 0; padding: 10px 12px; overflow: auto; border: 1px solid var(--color-border);
  border-radius: 8px; background: var(--color-surface-subtle); font: 12px / 1.55 var(--font-mono); white-space: pre; tab-size: 2;
}
</style>
