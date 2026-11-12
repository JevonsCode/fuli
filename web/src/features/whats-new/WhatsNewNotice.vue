<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { tourHoldsNotices } from '@/features/onboarding-tour/onboarding-tour'
import { currentLocale, t } from '@/i18n'
import { UiDialog, UiIcon, UiIconButton } from '@/ui'
import { linesFor, loadWhatsNew, markWhatsNewSeen, whatsNew } from './whats-new'

// After FULI updates, one floating glass notice says what is new (Jevons 11-08):
// 「更新到 x.y.z 了」, the release's first line in the console's language, and
// 「查看详情」 for all its lines and the GitHub release. It shows once per
// version (the server remembers), never on a new installation, and closes with ✕.
// It rises from the bottom right above the dock (layouts/CornerNotices.vue).
const details = ref(false)
const current = computed(() => whatsNew.shown)
const lines = computed(() => current.value ? linesFor(current.value, currentLocale()) : [])
// One thing at a time: while the beginner's guide is about to open or is open, the notice waits behind it.
const shown = computed(() => current.value !== null && !whatsNew.closed && lines.value.length > 0 && !tourHoldsNotices())
const title = computed(() => current.value ? t('whatsNew.title', { version: current.value.version }) : '')
const skipped = computed(() => current.value?.notice?.skipped ?? 0)
const skippedLabel = computed(() => skipped.value === 1 ? t('whatsNew.skippedOne') : t('whatsNew.skipped', { count: skipped.value }))

onMounted(() => { loadWhatsNew().catch(() => { /* an older server, or not answering: nothing to say */ }) })
// Seen means drawn: a notice still waiting behind the guide when the console closes shows next time.
watch(shown, (visible) => { if (visible) void markWhatsNewSeen() }, { immediate: true })
</script>

<template>
  <Transition name="whats-new">
    <section v-if="shown && current" class="whats-new" role="status" :aria-label="title" data-whats-new>
      <div class="whats-new-head">
        <p class="whats-new-title" data-whats-new-title>{{ title }}</p>
        <UiIconButton icon="close" size="sm" :label="t('common.actions.close')" data-whats-new-close @click="whatsNew.closed = true" />
      </div>
      <p class="whats-new-text" data-whats-new-text>{{ lines[0] }}</p>
      <div class="whats-new-actions">
        <Button type="button" size="sm" variant="outline" data-whats-new-details @click="details = true">{{ t('whatsNew.details') }}</Button>
        <a v-if="skipped > 0 && current.notice" class="whats-new-link" :href="current.notice.releasesUrl" target="_blank" rel="noreferrer"
          data-whats-new-skipped>{{ skippedLabel }}<UiIcon name="external" :size="12" /></a>
      </div>
    </section>
  </Transition>
  <UiDialog :open="details && current !== null" :title="title" size="sm" data-whats-new-dialog @close="details = false">
    <ul class="whats-new-lines" data-whats-new-lines>
      <li v-for="line in lines" :key="line">{{ line }}</li>
    </ul>
    <template #footer>
      <a v-if="current" class="whats-new-link" :href="current.releaseUrl" target="_blank" rel="noreferrer" data-whats-new-release>
        {{ t('whatsNew.release') }}<UiIcon name="external" :size="12" /></a>
    </template>
  </UiDialog>
</template>

<style scoped>
/* Glass, like every floating bar; the corner stack places it, so it takes no height from the page. */
.whats-new {
  display: grid; gap: 6px; padding: 12px 12px 12px 16px; border: 1px solid var(--edge-dock); border-radius: var(--radius-card, 12px);
  color: var(--color-ink); background: var(--glass-sheen), var(--surface-dock); box-shadow: var(--shadow-glass);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
/* The title and ✕ share one row and one centre line; the ✕ never moves. */
.whats-new-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; }
.whats-new-title { margin: 0; font-size: var(--text-control); font-weight: var(--weight-strong); }
/* The release's first line, at most two lines on screen. */
.whats-new-text {
  display: -webkit-box; margin: 0; padding-right: 8px; overflow: hidden; color: var(--color-ink-soft); font-size: var(--text-control);
  line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere;
}
.whats-new-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 4px; }
.whats-new-link {
  display: inline-flex; align-items: center; gap: 4px; color: var(--color-ink-soft); font-size: var(--text-meta);
  text-decoration: underline; text-underline-offset: 2px; user-select: none;
}
.whats-new-link:hover, .whats-new-link:focus-visible { color: var(--color-ink); }
.whats-new :deep(button) { user-select: none; }
.whats-new-lines { display: grid; gap: 10px; margin: 0; padding-left: 1.2em; color: var(--color-ink); line-height: 1.6; }
/* It rises from the bottom, above the dock. */
.whats-new-enter-active, .whats-new-leave-active { transition: opacity var(--motion-medium) var(--motion-ease), transform var(--motion-medium) var(--motion-ease); }
.whats-new-enter-from, .whats-new-leave-to { opacity: 0; transform: translateY(16px); }
</style>
