<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { loadNpmCopies, npmCopies, removalReason, removeNpmCopy, setNpmNoticeDismissed, type NpmCopy } from './npm-copies'

// Settings › 客户端: the npm copies of FULI beside the desktop app, each with
// 「卸载」 and whether the console reminds about it. A closed notice is found
// here again. Nothing shows when there is no npm copy (or no desktop app).
const store = useConsoleStore()
const error = ref('')

onMounted(() => { loadNpmCopies().catch(failure => { error.value = apiErrorReason(failure, t('npmCopies.loadError')) }) })

async function remove(copy: NpmCopy) {
  error.value = ''
  try {
    const result = await removeNpmCopy(copy)
    if (result.status === 'uninstalled') store.notify(t('npmCopies.removed', { version: result.version }))
  } catch (failure) { error.value = apiErrorReason(failure) }
}

async function remind(copy: NpmCopy, value: boolean) {
  error.value = ''
  try { await setNpmNoticeDismissed(copy, !value) } catch (failure) { error.value = apiErrorReason(failure) }
}
</script>

<template>
  <Card v-if="npmCopies.copies.length || error" as="section" id="npm-copies" class="settings-card" aria-labelledby="npm-copies-title"
    data-npm-copies-settings>
    <CardHeader>
      <CardTitle id="npm-copies-title" as="h2">{{ t('npmCopies.title') }}</CardTitle>
      <CardDescription>{{ t('npmCopies.description') }}</CardDescription>
    </CardHeader>
    <ul class="npm-copies">
      <li v-for="copy in npmCopies.copies" :key="copy.packageRoot" :data-npm-copy="copy.version">
        <span class="npm-copy-text">
          <strong>{{ t('npmCopies.version', { version: copy.version }) }}</strong>
          <small class="npm-copy-path" data-npm-copy-path>{{ t('npmCopies.path', { path: copy.packageRoot }) }}</small>
          <small v-if="copy.otherDataDir">{{ t('npmCopies.otherData', { version: copy.version, dataDir: copy.otherDataDir }) }}</small>
          <small v-else-if="copy.newer">{{ t('npmCopies.newer', { version: copy.version }) }}</small>
          <small v-if="copy.shellCommands.length">{{ t('npmCopies.shell', { commands: copy.shellCommands.join(' / ') }) }}</small>
          <template v-if="npmCopies.failed[copy.packageRoot]">
            <small class="npm-copy-failed" role="alert">{{ t('npmCopies.failed', { reason: removalReason(npmCopies.failed[copy.packageRoot].error) }) }}</small>
            <code class="npm-copy-command">{{ npmCopies.failed[copy.packageRoot].manualCommand }}</code>
          </template>
        </span>
        <span class="npm-copy-actions">
          <label class="npm-copy-remind">
            <Switch :model-value="!copy.noticeDismissed" :aria-label="t('npmCopies.remind')" data-npm-copy-remind
              @update:model-value="value => remind(copy, value)" />
            <small>{{ t('npmCopies.remind') }}</small>
          </label>
          <GrowthLoading v-if="npmCopies.removing === copy.packageRoot" variant="inline" :label="t('npmCopies.removing', { version: copy.version })" />
          <Button v-else-if="!copy.otherDataDir && !copy.newer" type="button" size="sm" variant="outline" :disabled="npmCopies.removing !== null" data-npm-copy-remove
            @click="remove(copy)">{{ t('npmCopies.remove') }}</Button>
        </span>
      </li>
    </ul>
    <p v-if="error" role="alert">{{ error }}</p>
  </Card>
</template>

<style scoped>
.npm-copies { display: grid; gap: 12px; margin: 0; padding: 0 var(--card-padding, 20px) var(--card-padding, 20px); list-style: none; }
.npm-copies li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.npm-copy-text { display: grid; gap: 2px; min-width: 0; }
.npm-copy-text small { color: var(--color-muted); }
.npm-copy-path { font-family: var(--font-mono); overflow-wrap: anywhere; }
.npm-copy-failed { color: var(--color-danger) !important; }
.npm-copy-command {
  padding: 6px 8px; border-radius: var(--radius-control); background: var(--color-surface-hover);
  font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; user-select: all;
}
.npm-copy-actions { display: flex; align-items: center; gap: 12px; user-select: none; }
.npm-copy-remind { display: inline-flex; align-items: center; gap: 6px; }
</style>
