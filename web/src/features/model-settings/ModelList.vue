<script setup lang="ts">
import { computed, ref } from 'vue'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { currentLocale, t } from '@/i18n'
import { roleName, type ModelRolesPayload } from './model'
import { healthLine, isFailing } from './model-health'
import { modelsInUse, useName, type ModelInUse, type ModelUseId } from './model-uses'
import { runRoleCheck, type RoleCheckResult } from './useRoleCheck'

// 模型 (11-06): every model FULI is connected to, once, with whether it works
// now (its latest call answered, or why not), who uses it, and 「测试连接」,
// whose answer replaces the line in place. A use is a button that opens that
// use's details; one that is off is listed quieter. Without any model it says
// only that, once.
const props = defineProps<{ payload: ModelRolesPayload }>()
const emit = defineEmits<{ open: [use: ModelUseId]; checked: [] }>()

const models = computed(() => modelsInUse(props.payload))
const checking = ref<string | null>(null)
const results = ref<Record<string, RoleCheckResult>>({})

// The saved settings are tested through a use that is on; a connection whose uses are all off makes no calls.
async function check(entry: ModelInUse) {
  if (!entry.checkRole) return
  checking.value = entry.id
  results.value = Object.fromEntries(Object.entries(results.value).filter(([id]) => id !== entry.id))
  const result = await runRoleCheck(entry.checkRole, entry.model)
  results.value = { ...results.value, [entry.id]: result }
  checking.value = null
  emit('checked')
}

function tone(entry: ModelInUse) {
  const result = results.value[entry.id]
  if (result) return result.ok ? 'ok' : 'failing'
  return isFailing(entry.health) ? 'failing' : entry.health?.status ?? 'unknown'
}
const line = (entry: ModelInUse) => results.value[entry.id]?.text ?? healthLine(entry.health, currentLocale())
</script>

<template>
  <Card class="model-list" data-model-list>
    <p v-if="!models.length" class="model-list-empty" data-model-list-empty>{{ t('modelSettings.power.off') }}</p>
    <ul v-else class="model-list-rows">
      <li v-for="entry in models" :key="entry.id" class="model-list-row" :data-model-connection-id="entry.id">
        <div class="model-list-name">
          <code :title="entry.label">{{ entry.label }}</code>
          <span :title="entry.service">{{ entry.service }}</span>
        </div>
        <p class="model-list-health" :class="`is-${tone(entry)}`" :role="tone(entry) === 'failing' ? 'alert' : 'status'" :title="line(entry)"
          :data-model-connection-health="tone(entry)">{{ line(entry) }}</p>
        <div class="model-list-uses" role="group" :aria-label="`${t('modelSettings.models.usedBy')} ${entry.model}`">
          <span class="model-list-label">{{ t('modelSettings.models.usedBy') }}</span>
          <Button v-for="item in entry.uses" :key="item.use" :variant="item.on ? 'secondary' : 'ghost'" size="sm" class="model-list-use" :class="{ 'is-off': !item.on }"
            :title="item.on ? undefined : t('modelSettings.models.off')" :data-model-use-chip="item.use" @click="emit('open', item.use)">
            {{ useName(item.use) }}
          </Button>
        </div>
        <Button variant="outline" size="sm" class="model-list-check" :disabled="!entry.checkRole || (checking !== null && checking !== entry.id)"
          :title="entry.checkRole ? undefined : t('modelSettings.models.checkOff')" :loading="checking === entry.id"
          :loading-label="entry.checkRole ? t('modelSettings.check.running', { name: roleName(entry.checkRole) }) : ''"
          :aria-label="`${t('modelSettings.check.run')} ${entry.model}`" data-model-connection-check @click="check(entry)">
          {{ t('modelSettings.check.run') }}
        </Button>
      </li>
    </ul>
  </Card>
</template>

<style scoped>
.model-list { gap: 0; padding: var(--space-2) var(--space-5); container-type: inline-size; }
.model-list-empty { margin: 0; padding: var(--space-2) 0; color: var(--color-muted); font-size: var(--text-body); }
.model-list-rows { display: grid; margin: 0; padding: 0; list-style: none; }
/* One row: the model, how it stands, who uses it, and the test at the right edge, where it never moves. */
.model-list-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name check" "health health" "uses uses";
  align-items: center; gap: var(--space-1) var(--space-4); min-height: 56px; padding: var(--space-3) 0;
}
.model-list-row + .model-list-row { border-top: 1px solid var(--color-border); }
.model-list-name { display: grid; grid-area: name; gap: 2px; min-width: 0; }
.model-list-name code { overflow: hidden; color: var(--color-ink); font-family: var(--font-mono); font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.model-list-name span { overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.model-list-health { grid-area: health; min-width: 0; margin: 0; overflow: hidden; color: var(--color-muted); font-size: var(--text-control); line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.model-list-health.is-ok { color: var(--color-success); }
.model-list-health.is-failing { color: var(--color-danger); }
.model-list-uses { display: flex; grid-area: uses; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.model-list-label { margin-inline-end: 4px; color: var(--color-muted); font-size: var(--text-meta); }
.model-list-use { border-radius: var(--radius-pill); user-select: none; }
.model-list-use.is-off { color: var(--color-muted); }
.model-list-check { grid-area: check; user-select: none; }
@container (min-width: 760px) {
  .model-list-row { grid-template-columns: minmax(10rem, 1.1fr) minmax(0, 1.4fr) minmax(0, 1.6fr) auto; grid-template-areas: "name health uses check"; padding: var(--space-2) 0; }
  .model-list-uses { justify-content: flex-end; }
}
</style>
