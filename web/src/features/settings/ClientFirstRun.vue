<script setup lang="ts">
import { computed, ref } from 'vue'
import { z } from 'zod'

import { postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'

// A connected client's own first-run question, while it is still ahead of the
// person (src/agents/client-first-run.js): for Cursor's CLI, "trust this
// folder" and "approve MCP" the first time it runs in a project folder. The one
// step FULI can take is its command for one folder; the card shows that
// command and the folder before it runs, and says how it went.
const props = defineProps<{ clientId: string, command: string }>()
// What the step answered (src/agents/cursor/first-run.js), checked before it is shown.
const outcomeSchema = z.looseObject({ status: z.enum(['approved', 'not_installed', 'no_answer', 'failed']),
  output: z.string().optional(), waitedMs: z.number().optional() })
const outcomeShape = shapeOf(outcomeSchema)
type Outcome = z.infer<typeof outcomeSchema>

const asking = ref(false)
const folder = ref('')
const running = ref(false)
const outcome = ref<Outcome | null>(null)
const failed = ref('')
const ready = computed(() => folder.value.trim().length > 0 && !running.value)

async function run() {
  running.value = true
  outcome.value = null
  failed.value = ''
  try {
    outcome.value = await postJson('/api/system/client-connection/first-run', { clientId: props.clientId, folder: folder.value.trim() }, outcomeShape)
  } catch (error) {
    failed.value = error instanceof Error ? error.message : String(error)
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="client-first-run" :data-client-first-run="clientId">
    <p class="client-row__meta client-row__note">{{ t(`settings.connection.clients.firstRun.${clientId}.note`) }}</p>
    <Button v-if="!asking" size="sm" variant="outline" data-first-run-start @click="asking = true">
      {{ t(`settings.connection.clients.firstRun.${clientId}.action`) }}
    </Button>
    <form v-else class="client-first-run__form" @submit.prevent="run">
      <label class="client-row__meta" :for="`first-run-folder-${clientId}`">{{ t('settings.connection.clients.firstRun.folder') }}</label>
      <Input :id="`first-run-folder-${clientId}`" v-model="folder" data-first-run-folder spellcheck="false" autocomplete="off" />
      <!-- What will run, before it runs. -->
      <p class="client-row__meta" data-first-run-command>
        {{ t('settings.connection.clients.firstRun.willRun', { command, folder: folder.trim() || '…' }) }}
      </p>
      <Button type="submit" size="sm" :disabled="!ready" :loading="running" data-first-run-run>{{ t('settings.connection.clients.firstRun.run') }}</Button>
    </form>
    <p v-if="outcome" :role="outcome.status === 'approved' ? 'status' : 'alert'" :data-first-run-outcome="outcome.status">
      {{ t(`settings.connection.clients.firstRun.outcome.${outcome.status}`, { seconds: Math.round((outcome.waitedMs ?? 0) / 1000) }) }}
      <template v-if="outcome.output"> {{ t('settings.connection.clients.firstRun.said', { output: outcome.output }) }}</template>
    </p>
    <p v-if="failed" role="alert" data-first-run-outcome="error">{{ failed }}</p>
  </div>
</template>

<style scoped>
.client-first-run { display: grid; gap: 6px; justify-items: start; }
.client-first-run__form { display: grid; gap: 6px; width: 100%; }
</style>
