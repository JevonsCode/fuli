<script setup lang="ts">
import { RouterLink } from 'vue-router'
import BrandEasterEgg from '@/components/BrandEasterEgg.vue'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import type { NavDestination } from './nav-destinations'

// Wide screens: a slim icon rail. Narrow screens: the same links as a bottom
// tab bar. Labels are the accessible names and tooltips, not visible text.
defineProps<{ destinations: readonly NavDestination[]; activeKey?: string; attentionCount: number; runtimeReady: boolean }>()
</script>

<template>
  <nav class="nav-rail" :aria-label="t('shell.aria')">
    <div class="nav-rail-brand"><BrandEasterEgg compact /></div>
    <ul class="nav-rail-links">
      <li v-for="destination in destinations" :key="destination.key">
        <RouterLink :to="destination.to" class="nav-rail-link" :class="{ 'is-active': destination.key === activeKey }"
          :aria-current="destination.key === activeKey ? 'page' : undefined"
          :aria-label="t(`shell.destinations.${destination.key}`)" :title="t(`shell.destinations.${destination.key}`)"
          :data-destination="destination.key">
          <UiIcon :name="destination.icon" :size="22" />
          <span class="nav-rail-label">{{ t(`shell.destinations.${destination.key}`) }}</span>
          <span v-if="destination.key === 'chat' && attentionCount" class="nav-rail-badge"
            :aria-label="t('shell.attentionBadge', { count: attentionCount })" data-attention-badge>{{ attentionCount > 9 ? '9+' : attentionCount }}</span>
        </RouterLink>
      </li>
    </ul>
    <span class="nav-rail-runtime" :class="{ 'is-ready': runtimeReady }" role="status"
      :title="t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline')"
      :aria-label="t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline')" />
  </nav>
</template>

<style scoped>
.nav-rail {
  position: sticky; top: 0; z-index: var(--z-nav); display: flex; flex-direction: column; align-items: center; gap: 12px;
  width: 72px; height: 100dvh; padding: 14px 0; border-right: 1px solid var(--color-border); background: var(--color-sidebar);
}
.nav-rail-brand { display: grid; place-items: center; width: 100%; padding-bottom: 6px; }
.nav-rail-links { display: flex; flex: 1; flex-direction: column; align-items: center; gap: 6px; margin: 0; padding: 0; list-style: none; }
.nav-rail-link {
  position: relative; display: grid; width: 48px; height: 48px; place-items: center; border-radius: 14px;
  color: var(--color-muted); text-decoration: none;
  transition: color var(--motion-fast), background var(--motion-fast), transform var(--motion-fast) var(--motion-ease);
}
.nav-rail-link:hover { color: var(--color-ink); background: var(--color-surface-hover); }
.nav-rail-link:active { transform: scale(.94); }
.nav-rail-link.is-active { color: var(--color-accent); background: var(--color-accent-soft); box-shadow: var(--glow-accent); }
.nav-rail-link:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* Text labels exist for the bottom bar and assistive tech; the rail shows icons only. */
.nav-rail-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.nav-rail-badge {
  position: absolute; top: 4px; right: 4px; display: grid; min-width: 18px; height: 18px; padding: 0 4px; place-items: center;
  border-radius: var(--radius-pill); color: var(--color-on-accent); background: var(--status-waiting);
  font-size: 11px; font-weight: 700; line-height: 1;
}
.nav-rail-runtime { width: 10px; height: 10px; border-radius: 50%; background: var(--status-error); }
.nav-rail-runtime.is-ready { background: var(--status-working); box-shadow: var(--glow-accent); }

@media (max-width: 720px) {
  .nav-rail {
    position: fixed; inset: auto 0 0; flex-direction: row; width: 100%; height: calc(60px + env(safe-area-inset-bottom));
    padding: 0 6px env(safe-area-inset-bottom); border-top: 1px solid var(--color-border); border-right: 0;
  }
  .nav-rail-brand, .nav-rail-runtime { display: none; }
  .nav-rail-links { flex-direction: row; justify-content: space-around; width: 100%; gap: 0; }
  /* Six tabs share the width, so 320px screens never clip the last one. */
  .nav-rail-links > li { display: flex; flex: 1 1 0; min-width: 0; justify-content: center; }
  .nav-rail-link { width: 100%; max-width: 64px; min-width: 0; height: 52px; grid-template-rows: auto auto; gap: 2px; border-radius: 12px; box-shadow: none; }
  .nav-rail-label { position: static; width: auto; max-width: 100%; height: auto; overflow: hidden; clip-path: none; font-size: 11px; font-weight: 600; text-overflow: ellipsis; }
}
</style>
