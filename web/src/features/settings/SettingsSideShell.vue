<script setup lang="ts">
import { ref } from 'vue'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { useSettingsOutline } from './settings-outline'
import { SETTINGS_TABS, type SettingsTab } from './settings-tabs'

// Layout B, 「左侧分类」: a fixed column on the left (the search, the topics
// with the open topic's cards under it, the layout switch at its foot) and the
// open topic's cards on the right, the only part that scrolls (Jevons 11-13:
// two halves only when one is fixed). The page passes the search, the switch
// and the topics' panels, as it does to the tabs; this shell only places them.
const tab = defineModel<SettingsTab>('tab', { required: true })
const props = defineProps<{ searching: boolean }>()
const scroller = ref<HTMLElement | null>(null)
const outline = useSettingsOutline(scroller, tab, () => props.searching)
</script>

<template>
  <div class="settings-side" data-settings-side>
    <aside class="settings-side-column">
      <slot name="search" />
      <nav class="settings-side-topics" :aria-label="t('settings.tabs.label')">
        <ul>
          <li v-for="topic in SETTINGS_TABS" :key="topic">
            <Button variant="ghost" class="settings-side-topic" :aria-current="topic === tab ? 'true' : undefined" :data-settings-topic="topic"
              @click="tab = topic"><span>{{ t(`settings.tabs.${topic}`) }}</span></Button>
            <ol v-if="topic === tab && outline.entries.value.length" class="settings-side-outline" :aria-label="t('common.outline')">
              <li v-for="(entry, index) in outline.entries.value" :key="index">
                <Button variant="ghost" size="sm" class="settings-side-outline-item" :aria-current="index === outline.current.value ? 'location' : undefined"
                  :title="entry.label" data-settings-outline-item @click="outline.go(index)"><span>{{ entry.label }}</span></Button>
              </li>
            </ol>
          </li>
        </ul>
      </nav>
      <slot name="layout" />
    </aside>
    <div ref="scroller" class="settings-side-content" data-settings-scroller><slot /></div>
  </div>
</template>

<style scoped>
/* The column stops above the dock, which floats at the bottom left; the cards scroll under it. */
.settings-side { display: flex; flex: 1; gap: 24px; min-width: 0; min-height: 0; }
.settings-side-column {
  display: flex; flex: 0 0 232px; flex-direction: column; gap: 16px; min-width: 0; min-height: 0; margin-bottom: 76px;
}
/* A topic list taller than the column scrolls inside it; the column itself never moves. */
.settings-side-topics { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.settings-side-topics ul, .settings-side-outline { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
/* The open topic and the card being read are marked by text colour only (11-07): no fill, no bar, no bolder weight. */
.settings-side-topic, .settings-side-outline-item {
  justify-content: flex-start; width: 100%; padding-inline: 8px; border: 0; background: transparent;
  transition: color var(--motion-fast) var(--motion-ease);
}
.settings-side-topic > span, .settings-side-outline-item > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.settings-side-topic:hover:not(:disabled), .settings-side-outline-item:hover:not(:disabled) { background: transparent; color: var(--color-ink-soft); }
.settings-side-topic { color: var(--color-muted); font-size: var(--text-body); font-weight: var(--weight-medium); }
.settings-side-outline { margin: 0 0 6px; padding-left: 16px; }
.settings-side-outline-item { color: var(--color-faint); font-size: var(--text-meta); font-weight: var(--weight-regular); }
.settings-side-topic[aria-current], .settings-side-outline-item[aria-current],
.settings-side-topic[aria-current]:hover:not(:disabled), .settings-side-outline-item[aria-current]:hover:not(:disabled) { color: var(--color-ink); }
/* Only this half scrolls; its foot clears the floating dock. */
.settings-side-content {
  display: grid; flex: 1; grid-template-columns: minmax(0, 1fr); align-content: start; gap: var(--space-4);
  min-width: 0; min-height: 0; padding: 0 6px 112px 0; overflow: auto; overscroll-behavior: contain;
}
</style>
