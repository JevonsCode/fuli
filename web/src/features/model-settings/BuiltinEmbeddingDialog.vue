<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiDialog } from '@/ui'
import {
  downloadBuiltinModel, downloadFailure, downloadPercent, megabytes, readBuiltinModels, removeBuiltinModel, useBuiltinModel,
  type BuiltinModel, type BuiltinModels,
} from './builtin-embedding'

// 「内置模型」 of 语义搜索: the small models FULI can download and run on this
// computer, one row each: what it is for, how much it downloads and uses, and
// one action. 「下载并使用」 needs nothing else: no address, no key, and
// nothing leaves the computer. While a download runs the list reads again
// every second; search switches by itself when the download is whole.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; changed: []; own: [] }>()

const store = useConsoleStore()
const list = ref<BuiltinModels | null>(null)
const loading = ref(false)
const error = ref('')
// The model whose 「使用」 or 「删除」 is being sent.
const acting = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let reading: AbortController | null = null

const downloading = (value: BuiltinModels | null) => Boolean(value?.models.some(model => model.download?.status === 'downloading'))

async function read() {
  clearTimeout(timer)
  reading?.abort()
  reading = new AbortController()
  loading.value = !list.value
  try {
    apply(await readBuiltinModels(reading.signal))
    error.value = ''
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') return
    error.value = apiErrorReason(cause)
  } finally {
    loading.value = false
  }
}

// The answer of a read or a change; a model that came into use tells the page to read its settings again.
function apply(next: BuiltinModels) {
  const before = list.value?.inUse ?? null
  const first = list.value === null
  list.value = next
  if (!first && next.inUse !== before) emit('changed')
  clearTimeout(timer)
  if (props.open && downloading(next)) timer = setTimeout(read, 1000)
}

async function act(model: BuiltinModel, send: (id: string) => Promise<BuiltinModels>, done?: string) {
  acting.value = model.id
  try {
    apply(await send(model.id))
    if (done) store.notify(done)
  } catch (cause) {
    store.reportError(cause)
  } finally {
    acting.value = null
  }
}

const download = (model: BuiltinModel) => act(model, downloadBuiltinModel)
const use = (model: BuiltinModel) => act(model, useBuiltinModel, t('modelSettings.builtin.usingNow', { name: model.name }))
const remove = (model: BuiltinModel) => act(model, removeBuiltinModel, t('modelSettings.builtin.removed', { name: model.name }))

const summary = (model: BuiltinModel) => (currentLocale() === 'zh-CN' ? model.summary.zh : model.summary.en)
const facts = (model: BuiltinModel) => t('modelSettings.builtin.facts', { size: megabytes(model.downloadBytes), memory: model.memoryMb })

watch(() => props.open, (open) => {
  if (open) void read()
  else { clearTimeout(timer); reading?.abort() }
}, { immediate: true })
onBeforeUnmount(() => { clearTimeout(timer); reading?.abort() })
</script>

<template>
  <UiDialog :open="open" :title="t('modelSettings.builtin.title')" :description="t('modelSettings.builtin.description')" size="lg"
    data-builtin-embedding-dialog @close="emit('close')">
    <GrowthLoading v-if="loading" variant="compact" :label="t('modelSettings.builtin.loading')" />
    <div v-else-if="error && !list" class="builtin-error" role="alert">
      <p>{{ t('modelSettings.builtin.loadFailed') }} {{ error }}</p>
      <Button size="sm" variant="outline" @click="read">{{ t('modelSettings.retry') }}</Button>
    </div>
    <ul v-else-if="list" class="builtin-list">
      <li v-for="model in list.models" :key="model.id" class="builtin-row" :data-builtin-model="model.id">
        <div class="builtin-main">
          <p class="builtin-head">
            <span class="builtin-name" :title="model.name">{{ model.name }}</span>
            <Badge v-if="model.inUse" variant="success" data-builtin-in-use>{{ t('modelSettings.builtin.inUse') }}</Badge>
            <Badge v-else-if="model.recommended" variant="secondary" data-builtin-recommended>{{ t('modelSettings.builtin.recommended') }}</Badge>
          </p>
          <p class="builtin-note" :title="`${summary(model)} ${facts(model)}`">{{ summary(model) }} {{ facts(model) }}</p>
          <p v-if="model.download?.status === 'failed'" class="builtin-failed" role="alert" data-builtin-failed>{{ downloadFailure(model.download.reason) }}</p>
        </div>
        <div class="builtin-actions">
          <GrowthLoading v-if="model.download?.status === 'downloading'" variant="inline" data-builtin-downloading
            :label="t('modelSettings.builtin.downloading', { name: model.name, percent: downloadPercent(model.download) })" />
          <template v-else-if="model.installed">
            <Button v-if="!model.inUse" size="sm" variant="ghost" :disabled="acting !== null" :loading="acting === model.id"
              :loading-label="t('modelSettings.builtin.removing', { name: model.name })" data-builtin-remove @click="remove(model)">
              {{ t('modelSettings.builtin.remove') }}
            </Button>
            <Button v-if="!model.inUse" size="sm" variant="outline" :disabled="acting !== null" data-builtin-use @click="use(model)">
              {{ t('modelSettings.builtin.use') }}
            </Button>
            <Button v-else-if="model.outdated" size="sm" variant="outline" :disabled="acting !== null" data-builtin-update @click="download(model)">
              {{ t('modelSettings.builtin.update') }}
            </Button>
          </template>
          <Button v-else size="sm" :variant="model.recommended ? 'default' : 'outline'" :disabled="acting !== null" data-builtin-download
            @click="download(model)">
            {{ t(model.download?.status === 'failed' ? 'modelSettings.retryAction' : 'modelSettings.builtin.downloadUse') }}
          </Button>
        </div>
      </li>
    </ul>
    <template #footer>
      <Button size="sm" variant="ghost" data-builtin-own @click="emit('own')">{{ t('modelSettings.builtin.own') }}</Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.builtin-error { display: grid; justify-items: start; gap: var(--space-3); color: var(--color-danger); font-size: var(--text-control); }
.builtin-error p { margin: 0; }
.builtin-list { display: grid; margin: 0; padding: 0; list-style: none; }
.builtin-row { display: flex; align-items: center; gap: var(--space-4); min-width: 0; padding-block: var(--space-3); }
.builtin-row + .builtin-row { border-top: 1px solid var(--color-border); }
.builtin-main { display: grid; flex: 1 1 auto; gap: 2px; min-width: 0; }
.builtin-head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; min-height: 24px; margin: 0; }
.builtin-name { min-width: 0; overflow: hidden; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.builtin-note { margin: 0; overflow: hidden; color: var(--color-muted); font-size: var(--text-control); line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.builtin-failed { margin: 0; color: var(--color-danger); font-size: var(--text-control); line-height: 20px; }
/* The action keeps its place and height whatever the row says: download, progress, or 使用 / 删除. */
.builtin-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: var(--space-2); min-height: var(--control-height-sm, 32px); }
.builtin-actions :deep(button) { user-select: none; }
</style>
