<script setup lang="ts">
import { computed, ref } from 'vue'
import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import UiNotice from '@/ui/UiNotice.vue'
import { t } from '@/i18n'
import { saveFile } from '@/lib/save-file'
import { useConsoleStore } from '@/stores/console'
import { diagnosticsExport, readDiagnosticsBundle, redactionSummary, type DiagnosticsBundle } from './diagnostics-bundle'

// 诊断包: 「生成诊断包」 shows exactly the files that would leave this
// computer, what was hidden on top; 「导出」 saves that same bundle as one file.
const store = useConsoleStore()
const bundle = ref<DiagnosticsBundle | null>(null)
const generating = ref(false)
const exporting = ref(false)
const error = ref('')
const exported = ref('')
const hidden = computed(() => bundle.value ? redactionSummary(bundle.value.redactions) : [])

async function generate() {
  const spaceId = store.activePersonalSpace?.id
  if (generating.value || !spaceId) return
  generating.value = true; error.value = ''; exported.value = ''
  try {
    bundle.value = await readDiagnosticsBundle(spaceId)
  } catch (caught) {
    error.value = t('settings.diagnostics.loadError', { reason: apiErrorReason(caught) })
  } finally {
    generating.value = false
  }
}

async function exportBundle() {
  if (!bundle.value || exporting.value) return
  exporting.value = true; error.value = ''; exported.value = ''
  try {
    const { name, content } = diagnosticsExport(bundle.value)
    const path = await saveFile(name, content, 'application/json;charset=utf-8')
    exported.value = path ? t('settings.diagnostics.exportedTo', { path }) : t('settings.diagnostics.exported')
  } catch (caught) {
    error.value = t('settings.diagnostics.exportError', { reason: apiErrorReason(caught) })
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <Card as="section" id="diagnostics" class="settings-card diagnostics-card" aria-labelledby="settings-diagnostics-title" data-diagnostics-card>
    <CardHeader>
      <CardTitle id="settings-diagnostics-title" as="h2">{{ t('settings.diagnostics.title') }}</CardTitle>
      <CardDescription>{{ t('settings.diagnostics.description') }}</CardDescription>
      <CardAction>
        <Button type="button" size="sm" variant="outline" :loading="generating" :loading-label="t('settings.diagnostics.generating')"
          :disabled="exporting" data-diagnostics-generate @click="generate">
          {{ t('settings.diagnostics.generate') }}
        </Button>
      </CardAction>
    </CardHeader>
    <div class="diagnostics-body">
      <UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
      <template v-if="bundle">
        <p class="diagnostics-redactions" data-diagnostics-redactions>
          <strong>{{ t('settings.diagnostics.redactions') }}</strong>
          <span v-if="!hidden.length">{{ t('settings.diagnostics.noRedactions') }}</span>
          <span v-for="line in hidden" :key="line">{{ line }}</span>
        </p>
        <ul class="diagnostics-files" :aria-label="t('settings.diagnostics.files')">
          <li v-for="file in bundle.files" :key="file.name">
            <details data-diagnostics-file>
              <summary><code>{{ file.name }}</code><small>{{ t('settings.diagnostics.fileSize', { size: file.content.length }) }}</small></summary>
              <pre>{{ file.content }}</pre>
            </details>
          </li>
        </ul>
        <div class="diagnostics-export">
          <Button type="button" size="sm" :loading="exporting" :loading-label="t('settings.diagnostics.exporting')"
            :disabled="generating" data-diagnostics-export @click="exportBundle">
            {{ t('settings.diagnostics.export') }}
          </Button>
          <UiNotice v-if="exported" tone="success">{{ exported }}</UiNotice>
        </div>
      </template>
    </div>
  </Card>
</template>

<style scoped>
.diagnostics-body { display: grid; gap: var(--space-3); padding-inline: 24px; }
.diagnostics-redactions { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; font-size: var(--text-meta); color: var(--color-muted); }
.diagnostics-redactions strong { color: var(--color-ink); font-weight: var(--weight-medium); }
.diagnostics-files { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.diagnostics-files details { border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.diagnostics-files summary { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; cursor: pointer; }
.diagnostics-files summary small { color: var(--color-muted); font-size: var(--text-meta); }
.diagnostics-files pre {
  max-height: 320px; margin: 0; padding: 8px 10px; overflow: auto; border-top: 1px solid var(--color-border);
  font-size: var(--text-meta); white-space: pre-wrap; overflow-wrap: anywhere;
}
.diagnostics-export { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
</style>
