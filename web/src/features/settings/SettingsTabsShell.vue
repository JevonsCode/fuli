<script setup lang="ts">
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { t } from '@/i18n'
import { SETTINGS_TABS } from './settings-tabs'

// Layout A, 「顶部标签」 (the default): the topics as tabs across the top, the
// search and the layout switch at the row's right end, the page scrolling as a
// whole. The page (SettingsPage.vue) passes the search, the switch and the
// topics' panels; this shell only places them.
</script>

<template>
  <div class="settings-tabbar flex flex-wrap items-end gap-x-4 gap-y-2 border-b">
    <TabsList class="-mb-px w-auto flex-1 border-b-0" :aria-label="t('settings.tabs.label')">
      <TabsTrigger v-for="tab in SETTINGS_TABS" :key="tab" :value="tab" :data-settings-tab-trigger="tab">
        {{ t(`settings.tabs.${tab}`) }}
      </TabsTrigger>
    </TabsList>
    <slot name="search" />
    <slot name="layout" />
  </div>
  <slot />
</template>

<style scoped>
.settings-tabbar { position: relative; }
/* The tabs keep their row; once the tabs and a 180px search no longer fit side by side, the search wraps under them. */
.settings-tabbar > :first-child { flex: 1 1 auto; min-width: min(100%, max-content); }
/* The client's narrowest window (460pt): 8px tab padding fits all five English tabs; narrower, the row scrolls on its own. */
@media (max-width: 520px) { .settings-tabbar :deep([role="tab"]) { padding-inline: 8px; } }
.settings-tabbar > :slotted(*) { margin-bottom: 6px; }
.settings-tabbar > :slotted(.settings-search) { flex: 0 1 300px; min-width: 180px; }
</style>
