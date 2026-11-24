<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { overviewTime } from '@/features/overview/overview-data'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import { askerLine, visitStateLabel } from './visit-request-model'
import type { VisitRequest } from './visit-request-shape'
import { useVisitDecision } from './useVisitDecision'
import '@/features/overview/workbench-card.css'
import './visit-card.css'

// One request in 等你拍板: who asks (the other computer and its assistant),
// the title and a small risk badge. Waiting for the call, 批准 and 拒绝 are one
// click each (a reason can be written on the card); a finished run says
// whether it is ready or needs a look and opens its review. The title opens the card.
const props = defineProps<{ item: VisitRequest }>()
const emit = defineEmits<{ open: [id: string] }>()
const decision = useVisitDecision()
const RISK_VARIANT = { low: 'secondary', medium: 'warning', high: 'destructive' } as const

const decide = (action: 'approve' | 'decline') => decision.decide(props.item, action)
</script>

<template>
  <div class="workbench-row" data-visit-row :data-visit-state="item.state">
    <span class="visit-mark" aria-hidden="true"><UiIcon name="roundtable" :size="16" /></span>
    <div class="workbench-row-text">
      <Button variant="link" class="workbench-row-title visit-row-open" aria-haspopup="dialog" data-visit-open @click="emit('open', item.id)">
        <span class="visit-row-title">{{ item.title }}</span>
      </Button>
      <p class="workbench-meta visit-row-meta">
        <span class="visit-row-asker">{{ t('visitRequests.meta', { asker: askerLine(item.requester), time: overviewTime(item.createdAt) }) }}</span>
        <Badge v-if="item.state === 'awaiting_review'" :variant="item.review === 'held' ? 'warning' : 'success'" data-visit-review>
          {{ visitStateLabel(item) }}
        </Badge>
        <Badge v-else-if="item.risk" :variant="RISK_VARIANT[item.risk.level]" data-visit-risk>{{ t(`visitRequests.risk.${item.risk.level}`) }}</Badge>
      </p>
    </div>
    <div v-if="item.state === 'awaiting_owner'" class="visit-row-actions">
      <Button variant="outline" size="sm" :disabled="Boolean(decision.busy.value)" :loading="decision.busy.value === 'decline'"
        :loading-label="t('visitRequests.pending.decline')" data-visit-decline @click="decide('decline')">{{ t('visitRequests.actions.decline') }}</Button>
      <Button size="sm" :disabled="Boolean(decision.busy.value)" :loading="decision.busy.value === 'approve'"
        :loading-label="t('visitRequests.pending.approve')" data-visit-approve @click="decide('approve')">{{ t('visitRequests.actions.approve') }}</Button>
    </div>
    <Button v-else variant="outline" size="sm" data-visit-look @click="emit('open', item.id)">{{ t('visitRequests.actions.look') }}</Button>
  </div>
</template>

<style scoped>
/* The title opens the card: the shared link Button, laid out as the row's title line. */
.visit-row-open { justify-content: flex-start; height: auto; min-height: 0; max-width: 100%; padding: 0; color: inherit; user-select: none; }
.visit-row-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-row-meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
.visit-row-asker { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-row-actions { display: flex; align-items: center; gap: 6px; }
</style>
