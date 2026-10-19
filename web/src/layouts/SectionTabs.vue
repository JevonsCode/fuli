<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import type { NavSection } from './nav-destinations'

// The active destination's sections as tabs in the top bar (e.g. 记忆:
// 知识 / 偏好 / 品味 / 知识整理), so merged pages stay one click away.
defineProps<{ sections: readonly NavSection[]; activeKey?: string }>()
</script>

<template>
  <nav v-if="sections.length > 1" class="section-tabs" :aria-label="t('shell.sectionsAria')">
    <RouterLink v-for="section in sections" :key="section.key" :to="section.to" class="section-tab"
      :class="{ 'is-active': section.key === activeKey }" :aria-current="section.key === activeKey ? 'page' : undefined"
      :data-section="section.key">
      {{ t(`shell.sections.${section.key}`) }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.section-tabs { display: flex; gap: 4px; padding: 3px; border-radius: var(--radius-pill); background: var(--color-surface-subtle); overflow-x: auto; scrollbar-width: none; }
.section-tab {
  flex: 0 0 auto; padding: 6px 14px; border-radius: var(--radius-pill); color: var(--color-muted);
  font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap;
  transition: color var(--motion-fast), background var(--motion-fast);
}
.section-tab:hover { color: var(--color-ink); }
.section-tab.is-active { color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.section-tab:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
</style>
