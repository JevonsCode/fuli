<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import type { NavSection } from './nav-destinations'

// The active destination's sections as tabs in the top bar (e.g. 记忆:
// 知识 / 偏好 / 知识整理 / 标签), so merged pages stay one click away.
defineProps<{ sections: readonly NavSection[]; activeKey?: string }>()
</script>

<template>
  <nav v-if="sections.length > 1" class="section-tabs" :aria-label="t('shell.sectionsAria')">
    <RouterLink v-for="section in sections" :key="section.key" :to="section.to" class="section-tab"
      :class="{ 'is-active': section.key === activeKey }" :aria-current="section.key === activeKey ? 'page' : undefined"
      :data-section="section.key" :data-term="`section.${section.key}`">
      {{ t(`shell.sections.${section.key}`) }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.section-tabs { display: flex; align-self: stretch; gap: 22px; overflow-x: auto; scrollbar-width: none; }
.section-tab {
  position: relative; display: flex; flex: 0 0 auto; align-items: center; padding: 6px 0; color: var(--color-muted);
  font-size: var(--text-control); font-weight: var(--weight-medium); text-decoration: none; white-space: nowrap;
  transition: color var(--motion-fast);
}
.section-tab::after {
  content: ''; position: absolute; right: 0; bottom: 4px; left: 0; height: 2px; border-radius: 2px; background: var(--color-ink);
  transform: scaleX(0); transition: transform var(--motion-move);
}
.section-tab:hover { color: var(--color-ink); }
.section-tab.is-active { color: var(--color-ink); }
.section-tab.is-active::after { transform: scaleX(1); }
.section-tab:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: 4px; }
</style>
