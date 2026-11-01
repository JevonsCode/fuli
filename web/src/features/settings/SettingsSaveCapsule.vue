<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'

// The settings page's save state, in a small glass capsule pinned bottom-right
// on the dock's line: saving, saved (fades), or failed with the reason and a retry.
// Applying a restart setting shows here too. Idle, nothing shows.
export type SaveCapsuleState = 'idle' | 'saving' | 'applying' | 'saved' | 'error'

defineProps<{ state: SaveCapsuleState; failure?: string }>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="settings-save-dock" aria-live="polite">
    <Transition name="settings-save-capsule">
      <div v-if="state !== 'idle'" class="settings-save-capsule" :data-state="state" data-settings-save-capsule>
        <GrowthLoading v-if="state === 'saving' || state === 'applying'" variant="inline"
          :label="t(state === 'applying' ? 'settings.applying' : 'settings.autosave.saving')" />
        <span v-else-if="state === 'saved'" class="settings-save-capsule__text">
          <UiIcon name="check" :size="14" />{{ t('settings.autosave.saved') }}
        </span>
        <template v-else>
          <span class="settings-save-capsule__text is-error" role="alert" :title="failure">
            {{ t('settings.autosave.failed') }}<template v-if="failure"> · {{ failure }}</template>
          </span>
          <Button type="button" variant="link" size="xs" class="settings-save-capsule__retry" data-settings-save-retry @click="emit('retry')">
            {{ t('settings.autosave.retry') }}
          </Button>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* On the dock's line: the dock is 56px tall, 20px above the bottom edge, and
   this 36px capsule sits on its middle. Right-aligned with the page canvas the
   same way the dock is left-aligned, so the two never meet. */
.settings-save-dock {
  position: fixed; right: calc(var(--page-inline) + var(--scrollbar-size)); bottom: 30px; z-index: var(--z-nav);
  pointer-events: none;
}
.settings-save-capsule {
  position: relative; display: flex; align-items: center; gap: 8px; height: 36px; max-width: min(440px, calc(100vw - 2 * var(--page-gutter)));
  padding: 0 14px; border: 1px solid var(--edge-dock); border-radius: var(--radius-pill); box-shadow: var(--shadow-glass);
  color: var(--color-ink-soft); font-size: var(--text-meta); font-weight: var(--weight-medium); white-space: nowrap;
  pointer-events: auto; user-select: none;
}
/* The glass lives on its own layer, as on the dock (AppDock.vue). */
.settings-save-capsule::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  background: var(--glass-sheen), var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
}
.settings-save-capsule__text { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.settings-save-capsule__text.is-error { display: block; color: var(--color-danger); }
.settings-save-capsule__retry { flex: 0 0 auto; min-height: 0; padding: 0; }

.settings-save-capsule-enter-active { transition: opacity var(--motion-exit), translate var(--motion-enter); }
.settings-save-capsule-leave-active { transition: opacity var(--motion-medium) var(--motion-ease-out); }
.settings-save-capsule-enter-from { opacity: 0; translate: 0 6px; }
.settings-save-capsule-leave-to { opacity: 0; }

@media (max-width: 720px) {
  /* The dock is centred on a phone: the capsule rises above it instead. */
  .settings-save-dock { bottom: calc(12px + env(safe-area-inset-bottom) + 56px + 10px); }
}
/* Without backdrop-filter the glass would let text through: a solid surface instead. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .settings-save-capsule { background: var(--color-surface); }
}
</style>
