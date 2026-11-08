<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiIconButton, UiNotice } from '@/ui'
import { loadNpmCopies, noticeCopy, npmCopies, removalReason, removeNpmCopy, setNpmNoticeDismissed } from './npm-copies'

// A floating glass notice when the desktop app found an older npm copy of
// FULI beside it (Jevons 11-08): it names the copy, offers 「卸载」 with no
// second confirmation, and closes for good with ×; Settings › 客户端 still
// lists the copy. It sits at the bottom right just above the dock
// (layouts/CornerNotices.vue), so it never covers the top bar, a page's tabs or its title.
// The Settings card that keeps the copy, with its 卸载, after this notice is closed.
const SETTINGS_CARD = '/settings?tab=clients#npm-copies'
const store = useConsoleStore()
const copy = computed(() => noticeCopy())
const failure = computed(() => copy.value ? npmCopies.failed[copy.value.packageRoot] ?? null : null)
const removing = computed(() => copy.value !== null && npmCopies.removing === copy.value.packageRoot)
const shown = computed(() => copy.value !== null)
// A copy on other data, or newer than the app, is only named: removing it is not what the app suggests.
const removable = computed(() => copy.value !== null && !copy.value.otherDataDir && !copy.value.newer)
const message = computed(() => {
  const target = copy.value
  if (!target) return ''
  if (target.otherDataDir) return t('npmCopies.otherData', { version: target.version, dataDir: target.otherDataDir })
  return t(target.newer ? 'npmCopies.newer' : 'npmCopies.notice', { version: target.version })
})

onMounted(() => { loadNpmCopies().catch(() => { /* outside the desktop app, or not answering: nothing to say */ }) })

async function remove() {
  const target = copy.value
  if (!target) return
  try {
    const result = await removeNpmCopy(target)
    if (result.status === 'uninstalled') store.notify(t('npmCopies.removed', { version: result.version }))
  } catch (error) {
    store.reportError(new Error(apiErrorReason(error)))
  }
}

async function close() {
  if (!copy.value) return
  try { await setNpmNoticeDismissed(copy.value, true) } catch (error) { store.reportError(new Error(apiErrorReason(error))) }
}
</script>

<template>
  <Transition name="npm-copy-notice">
    <div v-if="shown && copy" class="npm-copy-notice" data-npm-copy-notice>
      <UiNotice class="npm-copy-message" tone="info">
        {{ message }}
        <RouterLink class="npm-copy-later" :to="SETTINGS_CARD" data-npm-copy-later>{{ t('npmCopies.later') }}</RouterLink>
        <template v-if="failure">
          <p class="npm-copy-failed" role="alert">{{ t('npmCopies.failed', { reason: removalReason(failure.error) }) }}</p>
          <code v-if="failure.manualCommand" class="npm-copy-command" data-npm-copy-command>{{ failure.manualCommand }}</code>
        </template>
        <template #actions>
          <GrowthLoading v-if="removing" variant="inline" :label="t('npmCopies.removing', { version: copy.version })" />
          <Button v-else-if="removable" type="button" size="sm" variant="outline" data-npm-copy-remove @click="remove">{{ t('npmCopies.remove') }}</Button>
          <UiIconButton icon="close" size="sm" :label="t('common.actions.close')" :disabled="removing" data-npm-copy-close @click="close" />
        </template>
      </UiNotice>
    </div>
  </Transition>
</template>

<style scoped>
/* Glass, like every floating bar; the corner stack places it above the dock, taking no height from the page. */
.npm-copy-notice :deep(.npm-copy-message) {
  border: 1px solid var(--edge-dock); background: var(--glass-sheen), var(--surface-dock); box-shadow: var(--shadow-glass);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
/* The actions get a row of their own, clearly apart from the sentence. */
.npm-copy-notice :deep(.ui-notice__actions) { flex-basis: 100%; justify-content: flex-end; gap: 8px; margin: 12px 0 0; }
.npm-copy-later { display: block; margin-top: 6px; color: var(--color-ink); font-size: 12px; text-decoration: underline;
  text-underline-offset: 2px; user-select: none; }
.npm-copy-failed { margin: 6px 0 0; color: var(--color-danger); }
.npm-copy-command {
  display: block; margin-top: 4px; padding: 6px 8px; border-radius: var(--radius-control); background: var(--color-surface-hover);
  font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; user-select: all;
}
.npm-copy-notice :deep(button) { user-select: none; }
.npm-copy-notice-enter-active, .npm-copy-notice-leave-active { transition: opacity var(--motion-medium) var(--motion-ease), transform var(--motion-medium) var(--motion-ease); }
.npm-copy-notice-enter-from, .npm-copy-notice-leave-to { opacity: 0; transform: translateY(6px); }
</style>
