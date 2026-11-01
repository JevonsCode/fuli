<script setup lang="ts">
import { motion } from 'motion-v'
import { RouterLink } from 'vue-router'
import DockPins from '@/features/agent-profile/DockPins.vue'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import { UiIcon } from '@/ui'
import type { NavDestination } from './nav-destinations'

// The floating dock (sketch 2026-10-31, direction A): round icon buttons in
// one frosted-glass capsule like the macOS dock, left-aligned with the page.
// Names show as tooltips and are the links' accessible names. Pinned FLAs rise
// above the FLAs button. On the workbench the dock stays open; elsewhere it
// folds to the current destination and opens again on hover or keyboard focus
// (keyboard only: a clicked link keeps focus, which must not hold the dock open).
// The current icon is ink over a gold dot, and the dot glides to the next one
// on the spring.
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
  padding: 5px; border: 1px solid var(--edge-dock); border-radius: var(--radius-pill);
  background: var(--surface-dock); backdrop-filter: var(--filter-dock); -webkit-backdrop-filter: var(--filter-dock);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 10%), 0 10px 30px -10px rgb(var(--shadow-rgb) / 28%);
}
.app-dock-items { display: flex; gap: 4px; margin: 0; padding: 0; list-style: none; }
.app-dock-item { position: relative; display: flex; max-width: 44px; }
.app-dock-active { position: absolute; bottom: 6px; left: calc(50% - 2px); width: 4px; height: 4px; border-radius: 50%; background: var(--color-gold); }
.app-dock-link {
  position: relative; display: grid; width: 44px; height: 44px; place-items: center; border-radius: 50%;
  color: var(--color-muted); text-decoration: none;
  transition: color var(--motion-medium) var(--motion-ease-out), background var(--motion-fast), transform var(--motion-spring) var(--motion-ease-spring);
}
.app-dock-link:hover { color: var(--color-ink); background: var(--surface-glass-strong); }
.app-dock-link:hover:not([aria-current]) { transform: translateY(-2px); }
.app-dock-link:active { transform: scale(.92); }
.app-dock-item.is-active .app-dock-link { color: var(--color-ink); }
/* Names float above the button on hover and focus. */
.app-dock-link[data-tip]::after {
  content: attr(data-tip); position: absolute; bottom: calc(100% + 10px); left: 50%; padding: 4px 10px; transform: translateX(-50%);
  border: 1px solid var(--edge-glass); border-radius: var(--radius-pill); color: var(--color-ink); background: var(--surface-glass-strong);
  backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%); box-shadow: var(--shadow-md);
  font-size: var(--text-meta); font-weight: var(--weight-medium); white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity var(--motion-fast), translate var(--motion-spring) var(--motion-ease-spring); translate: 0 4px;
}
.app-dock-link[data-tip]:hover::after, .app-dock-link[data-tip]:focus-visible::after { opacity: 1; translate: 0 0; }
/* Pinned FLAs rise in their own capsule once the pointer rests on the FLAs button (hover intent),
   so sweeping across the dock or moving up from it never opens them; keyboard focus opens them at once.
   Only keyboard focus (:focus-visible) holds them open: a clicked pin keeps focus after it navigates,
   and that must not latch the capsule open over the page.
   Hidden, the capsule takes no pointer, so only the button's own 44px box starts it. Open, a bridge
   exactly as tall as the gap keeps it open on the way up. */
.app-dock-pins {
  position: absolute; bottom: calc(100% + 14px); left: 50%; transform: translate(-50%, 10px);
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity var(--motion-fast), transform var(--motion-spring) var(--motion-ease-spring), visibility 0s linear var(--motion-fast);
}
.app-dock-pins::after { content: ''; position: absolute; top: 100%; right: 0; left: 0; height: 14px; }
.app-dock-item.has-pins:hover .app-dock-pins {
  transform: translate(-50%, 0); opacity: 1; visibility: visible; pointer-events: auto; transition-delay: var(--motion-intent);
}
.app-dock-item.has-pins:has(:focus-visible) .app-dock-pins, .app-dock-pins:has(.is-holding) {
  transform: translate(-50%, 0); opacity: 1; visibility: visible; pointer-events: auto; transition-delay: 0s;
}
/* The portraits rise one after another, nearest the dock first, after the same rest on hover. */
.app-dock-pins :deep(.dock-pin) { opacity: 0; translate: 0 10px; scale: .8; transition: opacity var(--motion-fast), translate var(--motion-spring) var(--motion-ease-spring), scale var(--motion-spring) var(--motion-ease-spring), transform var(--motion-fast); transition-delay: calc(var(--pin-index, 0) * 35ms); }
.app-dock-item.has-pins:hover .app-dock-pins :deep(.dock-pin) { opacity: 1; translate: 0 0; scale: 1; transition-delay: calc(var(--motion-intent) + var(--pin-index, 0) * 35ms); }
.app-dock-item.has-pins:has(:focus-visible) .app-dock-pins :deep(.dock-pin), .app-dock-pins:has(.is-holding) :deep(.dock-pin) { opacity: 1; translate: 0 0; scale: 1; transition-delay: calc(var(--pin-index, 0) * 35ms); }
/* Folded: only the current destination shows until the dock is hovered or focused. */
.app-dock.is-folded:not(:hover, :has(:focus-visible)) .app-dock-item:not(.is-active) { max-width: 0; overflow: hidden; opacity: 0; }
.app-dock.is-folded:not(:hover, :has(:focus-visible)) .app-dock-items { gap: 0; }
.app-dock-item { transition: max-width var(--motion-spring) var(--motion-ease-spring), opacity var(--motion-medium) var(--motion-ease-out); }

@media (max-width: 720px) {
  .app-dock { bottom: calc(12px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); }
  /* A phone has no hover: the dock stays open. */
  .app-dock.is-folded:not(:hover, :has(:focus-visible)) .app-dock-item:not(.is-active) { max-width: 44px; overflow: visible; opacity: 1; }
  .app-dock.is-folded:not(:hover, :has(:focus-visible)) .app-dock-items { gap: 4px; }
}
/* Without backdrop-filter the glass would let text through: a solid surface instead. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .app-dock { background: var(--color-surface); }
}
@media (prefers-reduced-motion: reduce) { .app-dock-link, .app-dock-link::after, .app-dock-pins, .app-dock-item { transition: none; } }
:root[data-motion="reduced"] .app-dock-link, :root[data-motion="reduced"] .app-dock-link::after, :root[data-motion="reduced"] .app-dock-pins, :root[data-motion="reduced"] .app-dock-item { transition: none; }
</style>
