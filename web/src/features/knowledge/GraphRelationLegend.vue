<script setup lang="ts">
import { computed } from 'vue'

import { t } from '@/i18n'
import {
  RELATION_ICON_VIEWBOX,
  uniqueRelationVisuals,
} from './relation-visuals'

const props = defineProps<{
  relationTypes: string[]
}>()

const items = computed(() => uniqueRelationVisuals(props.relationTypes))
</script>

<template>
  <details v-if="items.length" class="graph-relation-legend">
    <summary>
      <svg :viewBox="RELATION_ICON_VIEWBOX" aria-hidden="true">
        <path d="M5 5h4v4H5zM15 15h4v4h-4zM9 7h4a4 4 0 0 1 4 4v4" />
      </svg>
      <span>{{ t('knowledge.workspace.graph.legend') }}</span>
      <small>{{ items.length }}</small>
      <i aria-hidden="true" />
    </summary>
    <div class="graph-relation-legend-panel">
      <header>
        <strong>{{ t('knowledge.workspace.graph.legend') }}</strong>
        <span>{{ t('knowledge.workspace.graph.legendCopy') }}</span>
      </header>
      <ul>
        <li v-for="item in items" :key="item.type">
          <svg :viewBox="RELATION_ICON_VIEWBOX" aria-hidden="true">
            <path :d="item.iconPath" />
          </svg>
          <span>
            <strong>{{ item.label }}</strong>
            <small>{{ item.description }}</small>
          </span>
        </li>
      </ul>
    </div>
  </details>
</template>
