<script setup lang="ts">
import { computed } from 'vue'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'

import { changesNewestFirst, type ClientObservation, type ConnectionStatus, type FuliInstall } from './client-connection-model'

// 查看详情 of one client's tile, or of the 「本机有两份 FULI」 notice (rec issue 106):
// what the entry runs against the console's own installation, and the full change history.
const props = defineProps<{ client?: ClientObservation, installs?: ConnectionStatus['installs'] }>()

const FULL_TIME = { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' } as const
const fullTime = (value: string) => formatDateTime(value, currentLocale(), FULL_TIME, { missing: '—' })
const versionOf = (install: FuliInstall) => install.version ?? t('settings.connection.clients.detail.noVersion')
const status = (value: string) => t(`settings.connection.clients.status.${value}`)
const changes = computed(() => props.client ? changesNewestFirst(props.client) : [])
</script>

<template>
  <DialogHeader>
    <DialogTitle>{{ client ? t('settings.connection.clients.detail.title', { client: client.label }) : t('settings.connection.clients.twoInstalls.title') }}</DialogTitle>
    <DialogDescription v-if="client?.overwritten">{{ t('settings.connection.clients.detail.overwritten', { client: client.label }) }}</DialogDescription>
    <DialogDescription v-else-if="!client">{{ t('settings.connection.clients.twoInstalls.advice') }}</DialogDescription>
  </DialogHeader>

  <section v-if="client" class="connection-detail" data-client-details-dialog>
    <template v-if="client.configuredInstall">
      <h3 class="ui-group-label">{{ t('settings.connection.clients.detail.installs') }}</h3>
      <dl class="connection-detail__installs">
        <dt>{{ t('settings.connection.clients.detail.configured') }}</dt>
        <dd data-detail-configured><code>{{ client.configuredInstall.path }}</code> · {{ versionOf(client.configuredInstall) }}
          <template v-if="!client.configuredInstall.exists"> · {{ t('settings.connection.clients.detail.missing') }}</template></dd>
        <template v-if="installs">
          <dt>{{ t('settings.connection.clients.detail.console') }}</dt>
          <dd data-detail-console><code>{{ installs.console.path }}</code> · {{ versionOf(installs.console) }}</dd>
        </template>
      </dl>
    </template>
    <h3 class="ui-group-label">{{ t('settings.connection.clients.detail.history') }}</h3>
    <ol v-if="changes.length" class="connection-detail__history">
      <li v-for="change in changes" :key="change.detectedAt" data-detail-change>
        <time :datetime="change.detectedAt">{{ fullTime(change.detectedAt) }}</time>
        <span>{{ status(change.from) }} → {{ status(change.to) }}</span>
        <span v-if="change.overwritten" class="connection-detail__mark">{{ t('settings.connection.clients.detail.overwrittenMark') }}</span>
      </li>
    </ol>
    <p v-else>{{ t('settings.connection.clients.detail.noHistory') }}</p>
  </section>

  <ul v-else-if="installs" class="connection-detail connection-detail__list" data-install-details>
    <li data-install="console"><code>{{ installs.console.path }}</code> · {{ versionOf(installs.console) }}
      <span class="connection-detail__mark">{{ t('settings.connection.clients.twoInstalls.inUse') }}</span></li>
    <li v-for="other in installs.others" :key="other.path" data-install="other"><code>{{ other.path }}</code> · {{ versionOf(other) }}
      <span class="connection-detail__mark">{{ t('settings.connection.clients.twoInstalls.usedBy', { clients: other.clients.join('、') }) }}</span></li>
  </ul>
</template>

<style scoped>
.connection-detail { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.connection-detail h3 { margin: 6px 0 0; }
.connection-detail p { margin: 0; color: var(--color-muted); }
.connection-detail code { font: 12px/1.6 var(--font-mono, monospace); overflow-wrap: anywhere; }
.connection-detail__installs { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; margin: 0; }
.connection-detail__installs dt { color: var(--color-muted); }
.connection-detail__installs dd { margin: 0; min-width: 0; }
.connection-detail__history { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.connection-detail__history li { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.connection-detail__history time { color: var(--color-muted); font-variant-numeric: tabular-nums; }
.connection-detail__list li { min-width: 0; }
.connection-detail__mark { color: var(--color-warning); font-size: 12px; }
</style>
