<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { apiErrorReason, getJson, putJson } from '@/api/client'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// Settings › 客户端: whether terminals run the desktop app's own fl and fuli
// (src/desktop/cli-path.js). Shown only on the desktop app.
interface CliPathState { supported: boolean; enabled: boolean }
const store = useConsoleStore()
const state = ref<CliPathState | null>(null)
const saving = ref(false)
const error = ref('')

onMounted(async () => {
  try { state.value = await getJson<CliPathState>('/api/system/cli-path') } catch (failure) { error.value = apiErrorReason(failure, t('cliPath.loadError')) }
})

async function set(enabled: boolean) {
  saving.value = true
  error.value = ''
  try {
    state.value = await putJson<CliPathState>('/api/system/cli-path', { enabled })
    store.notify(t('cliPath.saved'))
  } catch (failure) { error.value = apiErrorReason(failure) } finally { saving.value = false }
}
</script>

<template>
  <Card v-if="state?.supported" as="section" id="cli-path" class="settings-card" aria-labelledby="cli-path-title" data-cli-path-settings>
    <CardHeader>
      <CardTitle id="cli-path-title" as="h2">{{ t('cliPath.title') }}</CardTitle>
      <CardDescription>{{ t('cliPath.description') }}</CardDescription>
      <CardAction>
        <Switch :model-value="state.enabled" :disabled="saving" :aria-label="t('cliPath.switch')" data-cli-path-switch
          @update:model-value="set" />
      </CardAction>
    </CardHeader>
    <p v-if="error" role="alert" class="cli-path-error">{{ error }}</p>
  </Card>
</template>

<style scoped>
.cli-path-error { margin: 0; padding: 0 20px 16px; color: var(--color-danger); }
</style>
