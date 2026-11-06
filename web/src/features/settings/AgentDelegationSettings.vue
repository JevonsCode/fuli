<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiErrorReason, getJson, putJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { agentDelegationShape, type AgentDelegationPolicy } from './agent-delegation-model'

// Settings › AI permissions (rec#11 D-81): one switch per category of console
// changes FLAs may make for the person, saved at once; what each opens and
// the latest changes made sit in 「查看详情」.
const policy = ref<AgentDelegationPolicy | null>(null)
const loadError = ref('')
const saveError = ref('')
const saving = ref<string | null>(null)
const detailsOpen = ref(false)
const time = (value: string) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '-' })

onMounted(async () => {
  try { policy.value = await getJson('/api/agent-delegation', agentDelegationShape) }
  catch (error) { loadError.value = apiErrorReason(error, t('agentDelegation.loadError')) }
})

async function setCategory(id: string, enabled: boolean) {
  saving.value = id
  saveError.value = ''
  try {
    policy.value = await putJson(`/api/agent-delegation/categories/${encodeURIComponent(id)}`, { enabled }, agentDelegationShape)
  } catch (error) {
    saveError.value = apiErrorReason(error, t('agentDelegation.saveError'))
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <Card as="section" id="ai-permissions" class="settings-card agent-delegation-settings" aria-labelledby="agent-delegation-title" data-agent-delegation-settings>
    <CardHeader>
      <CardTitle id="agent-delegation-title" as="h2">{{ t('agentDelegation.title') }}<AiHelpButton term="task.aiPermissions" /></CardTitle>
      <CardDescription>{{ t('agentDelegation.description') }}</CardDescription>
      <CardAction>
        <Button type="button" size="sm" variant="outline" :disabled="!policy" aria-haspopup="dialog" data-agent-delegation-details
          @click="detailsOpen = true">
          {{ t('agentDelegation.details') }}
        </Button>
      </CardAction>
    </CardHeader>
    <div class="agent-delegation-body">
      <GrowthLoading v-if="!policy && !loadError" variant="compact" :label="t('agentDelegation.loading')" />
      <p v-if="loadError" role="alert">{{ loadError }}</p>
      <template v-if="policy">
        <div v-for="category in policy.categories" :key="category.id" class="agent-delegation-row" :data-delegation-category="category.id">
          <span>
            <strong>{{ t(`agentDelegation.categories.${category.id}.label`) }}</strong>
            <small>{{ t(`agentDelegation.categories.${category.id}.summary`) }}<template v-if="!category.defaultEnabled"> · {{ t('agentDelegation.defaultOff') }}</template></small>
          </span>
          <Switch :model-value="category.enabled" :disabled="saving === category.id"
            :aria-label="t(`agentDelegation.categories.${category.id}.label`)"
            @update:model-value="setCategory(category.id, $event)" />
        </div>
        <p v-if="saveError" role="alert">{{ saveError }}</p>
      </template>
    </div>

    <Dialog v-model:open="detailsOpen">
      <DialogContent size="lg" data-agent-delegation-dialog>
        <DialogHeader>
          <DialogTitle>{{ t('agentDelegation.detailsTitle') }}</DialogTitle>
          <DialogDescription>{{ t('agentDelegation.detailsDescription') }}</DialogDescription>
        </DialogHeader>
        <div class="agent-delegation-details">
          <section aria-labelledby="agent-delegation-always">
            <h3 id="agent-delegation-always" class="ui-group-label">{{ t('agentDelegation.alwaysYours') }}</h3>
            <p>{{ t('agentDelegation.alwaysYoursList') }}</p>
          </section>
          <section aria-labelledby="agent-delegation-words">
            <h3 id="agent-delegation-words" class="ui-group-label">{{ t('agentDelegation.yourWords') }}</h3>
            <p>{{ t('agentDelegation.yourWordsList') }}</p>
          </section>
          <section aria-labelledby="agent-delegation-recent" data-agent-delegation-recent>
            <h3 id="agent-delegation-recent" class="ui-group-label">{{ t('agentDelegation.recent') }}</h3>
            <p v-if="!policy?.operations.length">{{ t('agentDelegation.noRecent') }}</p>
            <ul v-else>
              <li v-for="operation in policy.operations" :key="operation.id" :data-delegated-operation="operation.id">
                <strong>{{ operation.route }}</strong>
                <small>{{ time(operation.at) }} · {{ operation.actor.agentId ?? (operation.actor.client === 'webmcp' ? t('aiHelp.webmcp.actor') : '-') }} · {{ operation.reason }}<template v-if="operation.outcome === 'failed'"> · {{ t('agentDelegation.failed') }}</template></small>
                <small v-if="operation.relayed" data-relayed-words>{{ t('agentDelegation.relayedWords', { words: operation.relayed.words }) }}</small>
                <small>{{ t('agentDelegation.undo', { undo: operation.undo }) }}</small>
              </li>
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  </Card>
</template>

<style scoped>
.agent-delegation-body { display: grid; gap: var(--space-3); padding-inline: 24px; font-size: var(--text-meta); }
.agent-delegation-body p { margin: 0; color: var(--color-muted); }
.agent-delegation-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.agent-delegation-row > span { display: grid; min-width: 0; gap: 4px; }
.agent-delegation-row strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.agent-delegation-row small { color: var(--color-muted); }
.agent-delegation-details { display: grid; gap: var(--space-4); font-size: var(--text-meta); }
.agent-delegation-details section { display: grid; gap: 8px; }
.agent-delegation-details p { margin: 0; color: var(--color-muted); }
.agent-delegation-details ul { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.agent-delegation-details li { display: grid; gap: 2px; }
.agent-delegation-details li strong { color: var(--color-ink); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.agent-delegation-details li small { color: var(--color-muted); }
</style>
