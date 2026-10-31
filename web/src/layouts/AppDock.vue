<script setup lang="ts">
import { RouterLink } from 'vue-router'
import DockPins from '@/features/agent-profile/DockPins.vue'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import type { NavDestination } from './nav-destinations'

// The floating dock (sketch 2026-10-31): round icon buttons in one capsule,
// left-aligned with the page. Names show as tooltips and are the links'
// accessible names. Pinned FLAs rise above the FLAs button. On the workbench
// the dock stays open; elsewhere it folds to the current destination and
// opens again on hover or keyboard focus.
defineProps<{ destinations: readonly NavDestination[]; activeKey?: string; spaceId: string; folded: boolean }>()
</script>

<template>
  <nav class="app-dock" :class="{ 'is-folded': folded }" :aria-label="t('shell.aria')" :data-folded="folded">
    <ul class="app-dock-items">
      <li v-for="destination in destinations" :key="destination.key" class="app-dock-item"
        :class="{ 'is-active': destination.key === activeKey, 'has-pins': destination.key === 'agents' }">
        <RouterLink :to="destination.to" class="app-dock-link"
          :aria-current="destination.key === activeKey ? 'page' : undefined" :aria-label="t(`shell.destinations.${destination.key}`)"
          :data-tip="destination.key === 'agents' ? undefined : t(`shell.destinations.${destination.key}`)"
          :data-destination="destination.key" :data-term="`destination.${destination.key}`">
          <UiIcon :name="destination.icon" :size="20" />
        </RouterLink>
        <div v-if="destination.key === 'agents'" class="app-dock-pins"><DockPins :space-id="spaceId" /></div>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.app-dock {
  position: fixed; bottom: 20px; left: var(--page-gutter); z-index: var(--z-nav);
  padding: 6px; border: 1px solid var(--edge-glass); border-radius: var(--radius-pill);
  background: var(--surface-glass-strong); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--shadow-sm), var(--shadow-lg);
}
.app-dock-items { display: flex; gap: 4px; margin: 0; padding: 0; list-style: none; }
.app-dock-item { position: relative; display: flex; }
.app-dock-link {
  position: relative; display: grid; width: 46px; height: 46px; place-items: center; border-radius: 50%;
  color: var(--color-muted); text-decoration: none;
  transition: color var(--motion-fast), background var(--motion-fast), transform var(--motion-fast) var(--motion-ease);
}
.app-dock-link:hover { color: var(--color-ink); background: var(--surface-glass-strong); }
.app-dock-link:active { transform: scale(.96); }
.app-dock-item.is-active .app-dock-link { color: var(--color-on-accent); background: var(--color-accent); }
/* Names float above the button on hover and focus. */
.app-dock-link[data-tip]::after {
  content: attr(data-tip); position: absolute; bottom: calc(100% + 10px); left: 50%; padding: 4px 10px; transform: translateX(-50%);
  border: 1px solid var(--edge-glass); border-radius: var(--radius-pill); color: var(--color-ink); background: var(--surface-glass-strong);
  font-size: var(--text-meta); font-weight: var(--weight-medium); white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity var(--motion-fast);
}
.app-dock-link[data-tip]:hover::after, .app-dock-link[data-tip]:focus-visible::after { opacity: 1; }
/* Pinned FLAs rise in their own capsule; the transparent bridge keeps the hover alive on the way up. */
.app-dock-pins {
  position: absolute; bottom: calc(100% + 14px); left: 50%; transform: translate(-50%, 10px);
  opacity: 0; pointer-events: none;
  transition: opacity var(--motion-fast), transform var(--motion-medium) var(--motion-ease);
}
.app-dock-pins::after { content: ''; position: absolute; top: 100%; right: 0; left: 0; height: 22px; }
.app-dock-item.has-pins:hover .app-dock-pins, .app-dock-item.has-pins:focus-within .app-dock-pins { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
/* Folded: only the current destination shows until the dock is hovered or focused. */
.app-dock.is-folded:not(:hover, :focus-within) .app-dock-item:not(.is-active) { width: 0; overflow: hidden; opacity: 0; }
.app-dock.is-folded:not(:hover, :focus-within) .app-dock-items { gap: 0; }
.app-dock-item { transition: width var(--motion-medium) var(--motion-ease), opacity var(--motion-fast); }

@media (max-width: 720px) {
  .app-dock { bottom: calc(12px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); }
  /* A phone has no hover: the dock stays open. */
  .app-dock.is-folded:not(:hover, :focus-within) .app-dock-item:not(.is-active) { width: auto; overflow: visible; opacity: 1; }
  .app-dock.is-folded:not(:hover, :focus-within) .app-dock-items { gap: 4px; }
}
@media (prefers-reduced-motion: reduce) { .app-dock-link, .app-dock-link::after, .app-dock-pins, .app-dock-item { transition: none; } }
:root[data-motion="reduced"] :is(.app-dock-link, .app-dock-link::after, .app-dock-pins, .app-dock-item) { transition: none; }
</style>
