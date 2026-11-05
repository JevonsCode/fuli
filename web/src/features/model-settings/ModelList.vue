<script setup lang="ts">
import { computed } from 'vue'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { t } from '@/i18n'
import type { ModelRolesPayload } from './model'
import { modelsInUse, useName, type ModelUseId } from './model-uses'

// 模型 (11-06): every model FULI is connected to, once, with who uses
// it. A use is a button that opens that use's details; one that is off is
// listed quieter. Without any model it says only that, once.
const props = defineProps<{ payload: ModelRolesPayload }>()
const emit = defineEmits<{ open: [use: ModelUseId] }>()

const models = computed(() => modelsInUse(props.payload))
</script>

<template>
  <Card class="model-list" data-model-list>
    <p v-if="!models.length" class="model-list-empty" data-model-list-empty>{{ t('modelSettings.power.off') }}</p>
    <ul v-else class="model-list-rows">
      <li v-for="entry in models" :key="entry.id" class="model-list-row" :data-model-connection-id="entry.id">
        <div class="model-list-name">
          <code :title="entry.model">{{ entry.model }}</code>
          <span :title="entry.service">{{ entry.service }}</span>
        </div>
        <div class="model-list-uses" role="group" :aria-label="`${t('modelSettings.models.usedBy')} ${entry.model}`">
          <span class="model-list-label">{{ t('modelSettings.models.usedBy') }}</span>
          <Button v-for="item in entry.uses" :key="item.use" :variant="item.on ? 'secondary' : 'ghost'" size="sm" class="model-list-use" :class="{ 'is-off': !item.on }"
            :title="item.on ? undefined : t('modelSettings.models.off')" :data-model-use-chip="item.use" @click="emit('open', item.use)">
            {{ useName(item.use) }}
          </Button>
        </div>
      </li>
    </ul>
  </Card>
</template>

<style scoped>
.model-list { gap: 0; padding: var(--space-2) var(--space-5); }
.model-list-empty { margin: 0; padding: var(--space-2) 0; color: var(--color-muted); font-size: var(--text-body); }
.model-list-rows { display: grid; margin: 0; padding: 0; list-style: none; }
.model-list-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-6); min-height: 56px; padding: var(--space-2) 0; }
.model-list-row + .model-list-row { border-top: 1px solid var(--color-border); }
.model-list-name { display: grid; gap: 2px; min-width: 0; }
.model-list-name code { overflow: hidden; color: var(--color-ink); font-family: var(--font-mono); font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.model-list-name span { overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.model-list-uses { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.model-list-label { margin-inline-end: 4px; color: var(--color-muted); font-size: var(--text-meta); }
.model-list-use { border-radius: var(--radius-pill); user-select: none; }
.model-list-use.is-off { color: var(--color-muted); }
</style>
