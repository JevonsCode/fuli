<script setup lang="ts">
import { computed } from 'vue'

import PageColumns from '@/components/PageColumns.vue'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import ConflictPolicyCard from '@/features/connections/ConflictPolicyCard.vue'
import ExternalKnowledgeSettings from '@/features/connections/ExternalKnowledgeSettings.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { RuntimePorts, RuntimeSettings } from '@/types'
import PeerSettings from './PeerSettings.vue'
import SettingsRestartNotice from './SettingsRestartNotice.vue'
import { fieldErrorId } from './settings-field-error'
import { PERSONAL_PORT_KEYS, type RestartField } from './settings-restart'

// Settings › 连接: what FULI connects to and who reaches it. The local graph
// service, external knowledge and its conflict policy, then the local
// network: access to this console, the ports, and the LAN roundtable.
// LAN access and the ports wait for the person's 应用并重启 (settings-restart.ts).
const form = defineModel<RuntimeSettings>('form', { required: true })
const props = defineProps<{
  active: RuntimeSettings
  pendingRestart: ReadonlySet<RestartField>
  applying: boolean
  applyError: string
  fieldErrors: Readonly<Record<string, string>>
}>()
const emit = defineEmits<{ apply: [] }>()

const store = useConsoleStore()
const personalReady = computed(() => store.state?.providers?.personal?.status === 'ready')
const hasProjects = computed(() => Boolean(store.state?.personalProjects?.length))
const errorFor = (key: string) => props.fieldErrors[key] ?? ''
const activePort = (key: keyof RuntimePorts) => props.active.ports[key] ?? '—'
</script>

<template>
  <PageColumns>
    <article class="settings-card service-connection-card" data-span="wide" :data-status="personalReady ? 'ready' : 'error'"
      :aria-label="t('pages.connections.statusAria')" data-local-graph>
      <header>
        <span class="service-connection-icon local" aria-hidden="true"><span class="nav-icon nav-icon-personal-project" /></span>
        <div><h2>{{ t('pages.connections.localGraphiti') }}</h2></div>
        <span class="service-state">{{ personalReady ? t('common.status.connected') : t('common.status.connectionError') }}</span>
      </header>
      <dl>
        <div><dt>{{ t('pages.connections.storage') }}</dt><dd>Neo4j</dd></div>
        <div><dt>{{ t('pages.connections.purpose') }}</dt><dd>{{ t('pages.connections.localPurpose') }}</dd></div>
      </dl>
    </article>
    <ExternalKnowledgeSettings data-span="wide" />
    <ConflictPolicyCard v-if="hasProjects" class="settings-card" />
    <Card as="section" class="settings-card" aria-labelledby="settings-lan-title">
      <CardHeader><CardTitle id="settings-lan-title" as="h2">{{ t('settings.groups.lan') }}<AiHelpButton term="task.lan" /></CardTitle></CardHeader>
      <div class="setting-list">
        <label class="setting-row">
          <span><strong>{{ t('settings.behavior.lanAccess') }}</strong><small>{{ t('settings.behavior.lanAccessMeta') }}</small></span>
          <Switch v-model="form.lanAccess" :aria-label="t('settings.behavior.lanAccess')" />
        </label>
      </div>
      <SettingsRestartNotice v-if="pendingRestart.has('lanAccess')" class="settings-restart" :applying="applying" :error="applyError" @apply="emit('apply')" />
    </Card>
    <Card as="section" id="ports" class="settings-card ports-card" aria-labelledby="settings-ports-title">
      <CardHeader><CardTitle id="settings-ports-title" as="h2">{{ t('settings.ports.title') }}<AiHelpButton term="task.ports" /></CardTitle></CardHeader>
      <div class="setting-list">
        <div class="port-section">
          <h3 class="ui-group-label">{{ t('settings.ports.personal') }}</h3>
          <div class="port-grid">
            <label v-for="key in PERSONAL_PORT_KEYS" :key="key">
              <span>{{ t(`settings.ports.${key}`) }}</span>
              <input v-model.number="form.ports[key]" type="number" min="1" max="65535" required
                :data-settings-field="`ports.${key}`" data-restart-field
                :aria-invalid="errorFor(`ports.${key}`) ? 'true' : undefined"
                :aria-describedby="errorFor(`ports.${key}`) ? fieldErrorId(`ports.${key}`) : undefined" />
              <small v-if="errorFor(`ports.${key}`)" :id="fieldErrorId(`ports.${key}`)" class="settings-field-error" data-settings-field-error>{{ errorFor(`ports.${key}`) }}</small>
              <small>{{ t('settings.ports.active', { port: activePort(key) }) }}</small>
            </label>
          </div>
          <SettingsRestartNotice v-if="pendingRestart.has('ports')" :applying="applying" :error="applyError" @apply="emit('apply')" />
        </div>
      </div>
    </Card>
    <PeerSettings />
  </PageColumns>
</template>

<style scoped>
.port-section { display: grid; gap: 13px; }
.port-section + .port-section { margin-top: 25px; padding-top: 22px; border-top: 1px solid var(--color-border); }
/* Short related fields sit side by side. */
.port-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.port-grid label { display: grid; gap: 7px; color: var(--color-muted); font-size: 12px; }
.port-grid input { width: 100%; min-width: 0; }
.port-grid small { color: var(--color-muted); font-size: 12px; }

@container (max-width: 640px) { .port-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 420px) { .port-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
