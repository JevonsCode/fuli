<script setup lang="ts">
import { motion } from 'motion-v'
import { RouterLink } from 'vue-router'
import DockPins from '@/features/agent-profile/DockPins.vue'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import { UiIcon } from '@/ui'
import type { NavDestination } from './nav-destinations'

// The floating dock (sketch 2026-10-31, direction A): round icon buttons in
// one solid ink capsule, left-aligned with the page. Names show as tooltips
// and are the links' accessible names. Pinned FLAs rise above the FLAs button.
// On the workbench the dock stays open; elsewhere it folds to the current
// destination and opens again on hover or keyboard focus. The current icon is
// white over a gold dot, and the dot glides to the next one on the spring.
defineProps<{ destinations: readonly NavDestination[]; activeKey?: string; spaceId: string; folded: boolean }>()
</script>

<template>
  <nav class="app-dock" :class="{ 'is-folded': folded }" :aria-label="t('shell.aria')" :data-folded="folded">
    <ul class="app-dock-items">
      <li v-for="destination in destinations" :key="destination.key" class="app-dock-item"
        :class="{ 'is-active': destination.key === activeKey, 'has-pins': destination.key === 'agents' }">
        <motion.span v-if="destination.key === activeKey" layout-id="app-dock-active" class="app-dock-active" :transition="SPRING" aria-hidden="true" />
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
  /* Left-aligned with the page canvas, which centres on very wide screens. */
  position: fixed; bottom: 20px; left: max(var(--page-gutter), calc((100vw - var(--canvas-max)) / 2)); z-index: var(--z-nav);
  padding: 5px; border-radius: var(--radius-pill); background: var(--color-ink);
  box-shadow: 0 12px 30px -8px rgb(var(--shadow-rgb) / 45%);
}
.app-dock-items { display: flex; gap: 4px; margin: 0; padding: 0; list-style: none; }
.app-dock-item { position: relative; display: flex; max-width: 44px; }
.app-dock-active { position: absolute; bottom: 6px; left: calc(50% - 2px); width: 4px; height: 4px; border-radius: 50%; background: var(--color-gold); }
.app-dock-link {
  position: relative; display: grid; width: 44px; height: 44px; place-items: center; border-radius: 50%;
  color: var(--color-faint); text-decoration: none;
  transition: color var(--motion-medium) var(--motion-ease-out), background var(--motion-fast), transform var(--motion-spring) var(--motion-ease-spring);
}
.app-dock-link:hover { color: var(--color-on-accent); background: color-mix(in srgb, var(--color-on-accent) 10%, transparent); }
.app-dock-link:hover:not([aria-current]) { transform: translateY(-2px); }
.app-dock-link:active { transform: scale(.92); }
.app-dock-item.is-active .app-dock-link { color: var(--color-on-accent); }
/* Names float above the button on hover and focus. */
.app-dock-link[data-tip]::after {
  content: attr(data-tip); position: absolute; bottom: calc(100% + 10px); left: 50%; padding: 4px 10px; transform: translateX(-50%);
  border-radius: var(--radius-pill); color: var(--color-on-accent); background: var(--color-ink); box-shadow: var(--shadow-md);
  font-size: var(--text-meta); font-weight: var(--weight-medium); white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity var(--motion-fast), translate var(--motion-spring) var(--motion-ease-spring); translate: 0 4px;
}
.app-dock-link[data-tip]:hover::after, .app-dock-link[data-tip]:focus-visible::after { opacity: 1; translate: 0 0; }
/* Pinned FLAs rise in their own capsule; the transparent bridge keeps the hover alive on the way up. */
.app-dock-pins {
  position: absolute; bottom: calc(100% + 14px); left: 50%; transform: translate(-50%, 10px);
  opacity: 0; pointer-events: none;
  transition: opacity var(--motion-fast), transform var(--motion-spring) var(--motion-ease-spring);
}
.app-dock-pins::after { content: ''; position: absolute; top: 100%; right: 0; left: 0; height: 22px; }
.app-dock-item.has-pins:hover .app-dock-pins, .app-dock-item.has-pins:focus-within .app-dock-pins, .app-dock-pins:has(.is-holding) { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
/* The portraits rise one after another, nearest the dock first. */
.app-dock-pins :deep(.dock-pin) { opacity: 0; translate: 0 10px; scale: .8; transition: opacity var(--motion-fast), translate var(--motion-spring) var(--motion-ease-spring), scale var(--motion-spring) var(--motion-ease-spring), transform var(--motion-fast); transition-delay: calc(var(--pin-index, 0) * 35ms); }
.app-dock-item.has-pins:is(:hover, :focus-within) .app-dock-pins :deep(.dock-pin), .app-dock-pins:has(.is-holding) :deep(.dock-pin) { opacity: 1; translate: 0 0; scale: 1; }
/* Folded: only the current destination shows until the dock is hovered or focused. */
.app-dock.is-folded:not(:hover, :focus-within) .app-dock-item:not(.is-active) { max-width: 0; overflow: hidden; opacity: 0; }
.app-dock.is-folded:not(:hover, :focus-within) .app-dock-items { gap: 0; }
.app-dock-item { transition: max-width var(--motion-spring) var(--motion-ease-spring), opacity var(--motion-medium) var(--motion-ease-out); }

@media (max-width: 720px) {
  .app-dock { bottom: calc(12px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); }
  /* A phone has no hover: the dock stays open. */
  .app-dock.is-folded:not(:hover, :focus-within) .app-dock-item:not(.is-active) { max-width: 44px; overflow: visible; opacity: 1; }
  .app-dock.is-folded:not(:hover, :focus-within) .app-dock-items { gap: 4px; }
}
@media (prefers-reduced-motion: reduce) { .app-dock-link, .app-dock-link::after, .app-dock-pins, .app-dock-item { transition: none; } }
:root[data-motion="reduced"] .app-dock-link, :root[data-motion="reduced"] .app-dock-link::after, :root[data-motion="reduced"] .app-dock-pins, :root[data-motion="reduced"] .app-dock-item { transition: none; }
</style>
