<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { formatDate } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import type { ServiceLog } from './agent-services'
import { logDetailText, logOutput } from './service-labels'

// One service's log, newest first: who did what and when, and the output tail
// of a process FULI owns (live while it runs, kept when it ended).
defineProps<{ log: ServiceLog | null; loading: boolean; error: string; name: string }>()
</script>

<template>
  <GrowthLoading v-if="loading && !log" variant="compact" :label="t('agentServices.log.loading', { name })" />
  <p v-else-if="error" role="alert" class="inline-error m-0">{{ error }}</p>
  <div v-else-if="log" class="grid gap-4" data-service-log>
    <section v-if="log.liveOutput" class="grid gap-1">
      <h3 class="m-0 text-xs font-semibold text-muted-foreground">{{ t('agentServices.log.liveOutput') }}</h3>
      <pre class="service-log-output bg-muted" data-service-live-output>{{ log.liveOutput }}</pre>
    </section>
    <p v-if="!log.entries.length" class="m-0 text-sm text-muted-foreground">{{ t('agentServices.log.empty') }}</p>
    <ol v-else class="m-0 grid list-none gap-3 p-0">
      <li v-for="entry in log.entries" :key="entry.id" class="grid gap-1" :data-service-log-entry="entry.action">
        <div class="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span class="font-semibold">{{ t(`agentServices.log.action.${entry.action}`) }}</span>
          <span class="text-muted-foreground">{{ t(`agentServices.log.actor.${entry.actor}`) }}</span>
          <span class="ml-auto text-xs tabular-nums text-muted-foreground">{{ formatDate(entry.at) }}</span>
        </div>
        <p v-if="logDetailText(entry)" class="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{{ logDetailText(entry) }}</p>
        <template v-if="logOutput(entry)">
          <span class="text-xs text-muted-foreground">{{ t('agentServices.log.output') }}</span>
          <pre class="service-log-output bg-muted">{{ logOutput(entry) }}</pre>
        </template>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.service-log-output {
  max-height: 260px; margin: 0; padding: 8px 10px; overflow: auto; border-radius: 6px;
  font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
}
</style>
