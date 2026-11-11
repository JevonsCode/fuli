<script setup lang="ts">
import { computed } from 'vue'

import PageColumns from '@/components/PageColumns.vue'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiIcon from '@/ui/UiIcon.vue'
import AgentDelegationSettings from './AgentDelegationSettings.vue'

// Settings › AI 能做什么: whether Agents may use FULI at all, what FLAs may
// change for the person, and whether confirmed knowledge answers directly.
// Tonborg's standards and the built-in Agents' models live on their own pages;
// this tab only links to them.
const store = useConsoleStore()
const agentAccessEnabled = computed(() => store.state?.agentAccessPolicy?.enabled !== false)
const answerFromConfirmed = computed(() => store.state?.recallPolicy?.answerFromConfirmed !== false)
</script>

<template>
  <PageColumns>
    <Card as="section" class="settings-card" aria-labelledby="settings-access-title">
      <CardHeader><CardTitle id="settings-access-title" as="h2">{{ t('settings.groups.access') }}<AiHelpButton term="task.access" /></CardTitle></CardHeader>
      <div class="setting-list">
        <label class="setting-row">
          <span><strong>{{ t('settings.behavior.agentAccess') }}</strong><small>{{ t('settings.behavior.agentAccessMeta') }}</small></span>
          <Switch :model-value="agentAccessEnabled" :aria-label="t('settings.behavior.agentAccess')" @update:model-value="store.updateAgentAccessPolicy($event)" />
        </label>
      </div>
    </Card>
    <AgentDelegationSettings />
    <Card as="section" class="settings-card" aria-labelledby="settings-answer-title" data-recall-answer-card>
      <div class="setting-list">
        <label class="setting-row" data-recall-answer-from-confirmed>
          <span><strong id="settings-answer-title">{{ t('settings.behavior.answerFromConfirmed') }}</strong><small>{{ t('settings.behavior.answerFromConfirmedMeta') }}</small></span>
          <Switch :model-value="answerFromConfirmed" :aria-label="t('settings.behavior.answerFromConfirmed')" @update:model-value="store.updateRecallPolicy($event)" />
        </label>
      </div>
    </Card>
    <Card as="section" class="settings-card" :aria-label="t('settings.elsewhere')" data-settings-elsewhere>
      <div class="setting-list">
        <RouterLink class="setting-row" to="/employees/tonborg?view=standards" data-open-judgment-standards>
          <span><strong>{{ t('judgment.settings.link') }}</strong></span>
          <UiIcon name="chevron-right" :size="16" class="setting-row-arrow" />
        </RouterLink>
        <RouterLink class="setting-row" to="/models" data-open-model-settings>
          <span><strong>{{ t('modelSettings.settingsLink') }}</strong></span>
          <UiIcon name="chevron-right" :size="16" class="setting-row-arrow" />
        </RouterLink>
      </div>
    </Card>
  </PageColumns>
</template>
