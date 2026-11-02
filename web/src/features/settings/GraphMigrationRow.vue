<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import { LEGACY_MIGRATION_GUIDE_URL, readGraphMigration, startGraphMigration, type GraphMigration } from './graph-migration'

// An older install still keeps its knowledge in a Docker graph (src/system/graph-migration.js).
// One click moves it into the built-in graph; FULI restarts on its own. When
// the last attempt did not finish, the guide an AI can follow sits beside the retry.
const migration = ref<GraphMigration | null>(null)
const starting = ref(false)
const error = ref('')

onMounted(async () => {
  try { migration.value = await readGraphMigration() } catch { /* the button still works without the last attempt */ }
})

async function start() {
  if (starting.value) return
  starting.value = true; error.value = ''
  try {
    migration.value = await startGraphMigration()
  } catch (caught) {
    error.value = t('settings.graphMigration.startError', { reason: apiErrorReason(caught) })
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <div class="setting-row graph-migration" data-graph-migration>
    <span>
      <strong>{{ t('settings.graphMigration.title') }}</strong>
      <small v-if="migration?.status === 'running'">{{ t('settings.graphMigration.running') }}</small>
      <small v-else-if="migration?.status === 'failed'">{{ t('settings.graphMigration.failed') }}</small>
      <small v-else>{{ t('settings.graphMigration.summary') }}</small>
    </span>
    <span class="graph-migration-actions">
      <a v-if="migration?.status === 'failed'" :href="LEGACY_MIGRATION_GUIDE_URL" target="_blank" rel="noreferrer"
        data-graph-migration-guide>{{ t('settings.graphMigration.guide') }}</a>
      <Button type="button" size="sm" :loading="starting || migration?.status === 'running'"
        :loading-label="t('settings.graphMigration.starting')" data-graph-migration-start @click="start">
        {{ t(migration?.status === 'failed' ? 'settings.graphMigration.retry' : 'settings.graphMigration.start') }}
      </Button>
    </span>
    <UiNotice v-if="error" tone="error" class="graph-migration-error">{{ error }}</UiNotice>
  </div>
</template>

<style scoped>
.graph-migration { flex-wrap: wrap; }
.graph-migration-actions { display: inline-flex; align-items: center; gap: 12px; font-size: var(--text-meta); }
.graph-migration-error { flex-basis: 100%; }
</style>
