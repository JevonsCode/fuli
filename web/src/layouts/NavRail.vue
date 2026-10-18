<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import BrandEasterEgg from '@/components/BrandEasterEgg.vue'
import { t } from '@/i18n'
import { UiIcon, UiIconButton } from '@/ui'
import type { NavDestination } from './nav-destinations'

// Wide screens: an icon rail that expands to show names (remembered per
// browser). Narrow screens: the same links as a bottom tab bar with labels.
defineProps<{ destinations: readonly NavDestination[]; activeKey?: string; attentionCount: number; runtimeReady: boolean }>()

const STORAGE_KEY = 'fuli.nav.expanded'
// Expanded until the person collapses it: names are clearer than icons alone.
function readExpanded() {
  try { return localStorage.getItem(STORAGE_KEY) !== '0' } catch { return true }
}
const expanded = ref(readExpanded())
const route = useRoute()
// The three profile aspects open the preferences page already filtered.
const PROFILE_ASPECTS = ['taste', 'personality', 'judgment_preference'] as const
const aspectActive = (aspect: string) => route.path === '/preferences' && route.query.aspect === aspect
watch(expanded, value => {
  try { localStorage.setItem(STORAGE_KEY, value ? '1' : '0') } catch { /* storage may be unavailable */ }
})
</script>

<template>
  <nav class="nav-rail" :class="{ 'is-expanded': expanded }" :aria-label="t('shell.aria')" :data-expanded="expanded">
    <div class="nav-rail-brand"><BrandEasterEgg compact /><span v-if="expanded" class="nav-rail-wordmark">{{ t('shell.brand') }}</span></div>
    <ul class="nav-rail-links">
      <li v-for="destination in destinations" :key="destination.key">
        <RouterLink :to="destination.to" class="nav-rail-link" :class="{ 'is-active': destination.key === activeKey }"
          :aria-current="destination.key === activeKey ? 'page' : undefined"
          :aria-label="t(`shell.destinations.${destination.key}`)" :title="expanded ? undefined : t(`shell.destinations.${destination.key}`)"
          :data-destination="destination.key">
          <UiIcon :name="destination.icon" :size="22" />
          <span class="nav-rail-label">{{ t(`shell.destinations.${destination.key}`) }}</span>
          <span v-if="destination.key === 'chat' && attentionCount" class="nav-rail-badge"
            :aria-label="t('shell.attentionBadge', { count: attentionCount })" data-attention-badge>{{ attentionCount > 9 ? '9+' : attentionCount }}</span>
        </RouterLink>
        <ul v-if="expanded && destination.key === 'memory'" class="nav-rail-sublinks" :aria-label="t('shell.profileAria')">
          <li v-for="aspect in PROFILE_ASPECTS" :key="aspect">
            <RouterLink :to="{ path: '/preferences', query: { aspect } }" class="nav-rail-sublink" :class="{ 'is-active': aspectActive(aspect) }"
              :aria-current="aspectActive(aspect) ? 'page' : undefined" :data-aspect="aspect">{{ t(`knowledge.domain.profiles.${aspect}`) }}</RouterLink>
          </li>
        </ul>
      </li>
    </ul>
    <div class="nav-rail-foot">
      <span class="nav-rail-runtime" role="status" :title="t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline')">
        <span class="nav-rail-runtime-dot" :class="{ 'is-ready': runtimeReady }" aria-hidden="true" />
        <span class="nav-rail-runtime-text">{{ t(runtimeReady ? 'shell.runtimeReady' : 'shell.runtimeOffline') }}</span>
      </span>
      <UiIconButton class="nav-rail-toggle" :icon="expanded ? 'chevron-left' : 'chevron-right'" size="sm"
        :label="t(expanded ? 'shell.collapse' : 'shell.expand')" data-nav-toggle @click="expanded = !expanded" />
    </div>
  </nav>
</template>

<style scoped>
.nav-rail {
  position: sticky; top: 0; z-index: var(--z-nav); display: flex; flex: 0 0 auto; flex-direction: column; align-items: center; gap: 12px;
  width: 72px; height: 100dvh; padding: 14px 0 12px; border-right: 1px solid var(--color-border); background: var(--color-sidebar);
  transition: width var(--motion-medium) var(--motion-ease);
}
.nav-rail.is-expanded { width: 208px; align-items: stretch; padding-inline: 12px; }
.nav-rail-brand { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding-bottom: 6px; }
.nav-rail.is-expanded .nav-rail-brand { justify-content: flex-start; padding-left: 4px; }
.nav-rail-wordmark { color: var(--color-ink); font-size: 17px; font-weight: 800; letter-spacing: .08em; white-space: nowrap; }
.nav-rail-links { display: flex; flex: 1; flex-direction: column; align-items: center; gap: 6px; margin: 0; padding: 0; list-style: none; }
.nav-rail.is-expanded .nav-rail-links { align-items: stretch; }
.nav-rail-link {
  position: relative; display: grid; width: 48px; height: 48px; place-items: center; border-radius: 14px;
  color: var(--color-muted); text-decoration: none;
  transition: color var(--motion-fast), background var(--motion-fast), transform var(--motion-fast) var(--motion-ease);
}
.nav-rail.is-expanded .nav-rail-link {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 12px; line-height: 1;
}
/* Expanded, the active row is a flat tint centred on its text, no glow. */
.nav-rail.is-expanded .nav-rail-link.is-active { box-shadow: none; }
.nav-rail-link:hover { color: var(--color-ink); background: var(--color-surface-hover); }
.nav-rail-link:active { transform: scale(.96); }
.nav-rail-link.is-active { color: var(--color-accent); background: var(--color-accent-soft); box-shadow: var(--glow-accent); }
.nav-rail-link:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* Collapsed, the label is the accessible name only; expanded, it is shown. */
.nav-rail-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.nav-rail.is-expanded .nav-rail-label { position: static; width: auto; height: auto; overflow: visible; clip-path: none; font-size: 14px; font-weight: 600; }
.nav-rail-badge {
  position: absolute; top: 4px; right: 4px; display: grid; min-width: 18px; height: 18px; padding: 0 4px; place-items: center;
  border-radius: var(--radius-pill); color: var(--color-on-accent); background: var(--status-waiting);
  font-size: 11px; font-weight: 700; line-height: 1;
}
.nav-rail.is-expanded .nav-rail-badge { position: static; margin-left: auto; }
/* Second level: same column as the first-level names, told apart by colour. */
.nav-rail-sublinks { display: grid; gap: 2px; margin: 0 0 4px; padding: 0; list-style: none; }
.nav-rail-sublink {
  display: flex; align-items: center; height: 32px; padding: 0 12px 0 44px; border-radius: 10px;
  color: var(--color-faint); font-size: 13px; font-weight: 500; line-height: 1; text-decoration: none;
  transition: color var(--motion-fast), background var(--motion-fast);
}
.nav-rail-sublink:hover { color: var(--color-ink); background: var(--color-surface-hover); }
.nav-rail-sublink.is-active { color: var(--color-accent); background: var(--color-accent-soft); }
.nav-rail-sublink:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.nav-rail-foot { display: flex; flex-direction: column; align-items: center; gap: 10px; }
/* Status first, the collapse control alone on the last line. */
.nav-rail.is-expanded .nav-rail-foot { align-items: flex-start; padding-left: 12px; }
.nav-rail.is-expanded .nav-rail-toggle { margin-left: -7px; }
.nav-rail-runtime { display: inline-flex; align-items: center; gap: 8px; color: var(--color-muted); font-size: 12px; }
.nav-rail-runtime-text { display: none; }
.nav-rail.is-expanded .nav-rail-runtime-text { display: inline; }
.nav-rail-runtime-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--status-error); }
.nav-rail-runtime-dot.is-ready { background: var(--status-working); box-shadow: var(--glow-accent); }

@media (max-width: 720px) {
  .nav-rail, .nav-rail.is-expanded {
    position: fixed; inset: auto 0 0; flex-direction: row; width: 100%; height: calc(60px + env(safe-area-inset-bottom));
    padding: 0 6px env(safe-area-inset-bottom); border-top: 1px solid var(--color-border); border-right: 0;
  }
  .nav-rail-brand, .nav-rail-foot, .nav-rail-sublinks { display: none; }
  .nav-rail-links, .nav-rail.is-expanded .nav-rail-links { flex-direction: row; justify-content: space-around; width: 100%; gap: 0; }
  /* Six tabs share the width, so 320px screens never clip the last one. */
  .nav-rail-links > li { display: flex; flex: 1 1 0; min-width: 0; justify-content: center; }
  .nav-rail-link, .nav-rail.is-expanded .nav-rail-link {
    display: grid; width: 100%; max-width: 64px; min-width: 0; height: 52px; padding: 0; place-items: center;
    grid-template-rows: auto auto; gap: 2px; border-radius: 12px; box-shadow: none;
  }
  .nav-rail-label, .nav-rail.is-expanded .nav-rail-label {
    position: static; width: auto; max-width: 100%; height: auto; overflow: hidden; clip-path: none;
    font-size: 11px; font-weight: 600; text-overflow: ellipsis;
  }
  .nav-rail.is-expanded .nav-rail-badge { position: absolute; }
}
@media (prefers-reduced-motion: reduce) { .nav-rail { transition: none; } }
:root[data-motion="reduced"] .nav-rail { transition: none; }
</style>
