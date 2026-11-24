<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import AgentAvatar from '@/features/agent-profile/AgentAvatar.vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { inboxLocation, type AgentAttention } from '@/features/project-agents/attention-store'
import { t } from '@/i18n'
import './workbench-card.css'

// One open request an FLA is waiting on: who asks, what, when, and 回应, which
// opens it in 待决策 to answer there (工作台 and 今天 share it).
defineProps<{ item: AgentAttention; name: string; time: string }>()
</script>

<template>
  <div class="workbench-row" data-workbench-request>
    <span class="workbench-face" :style="agentIdentityStyle(item.agentId)"><AgentAvatar :agent-id="item.agentId" :name="name" /></span>
    <div class="workbench-row-text">
      <p class="workbench-row-title">{{ item.title?.trim() || t('overview.missing.requestTitle') }}</p>
      <p class="workbench-meta">{{ t('overview.attention.meta', { name, time }) }}</p>
    </div>
    <Button as-child variant="outline" size="sm"><RouterLink :to="inboxLocation(item.agentId, item.requestId)">{{ t('overview.attention.respond') }}</RouterLink></Button>
  </div>
</template>
