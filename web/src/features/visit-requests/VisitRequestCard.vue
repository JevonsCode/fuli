<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { overviewTime } from '@/features/overview/overview-data'
import { t } from '@/i18n'
import RequesterModeSelect from './RequesterModeSelect.vue'
import VisitRequestReview from './VisitRequestReview.vue'
import type { VisitAction } from './visit-request-api'
import { askerLine, checkName, decisionText, endingText, eventText, modeName, planErrorText, reviewExpired, ruleChecks, shownText, visitActions,
  visitStateLabel, waitsForConstrainedClient } from './visit-request-model'
import type { VisitRequestCard } from './visit-request-shape'
import './visit-card.css'

// One request in its quick look, key points first: the requester's own words
// (plain text, never markup), the assistant's assessment, which mode applied
// and who decided, the result once there is one, and what happened in order.
// The actions valid for its state stay at the card's foot while it scrolls.
const props = defineProps<{ card: VisitRequestCard; busy: VisitAction | '' }>()
const emit = defineEmits<{ act: [action: VisitAction, reason: string]; changed: [] }>()
const reason = ref('')
const REASON_CHARS = 200
const ACTION_VARIANT = { approve: 'default', keep: 'default', decline: 'outline', cancel: 'outline', discard: 'destructive' } as const
const ACTION_HINT: Partial<Record<VisitAction, string>> = { keep: 'keepHint', discard: 'discardHint', cancel: 'cancelHint' }

const plan = computed(() => props.card.plan)
const actions = computed(() => visitActions(props.card))
const checks = computed(() => ruleChecks(props.card))
const ending = computed(() => endingText(props.card))
const hasResult = computed(() => Boolean(props.card.result) || ['awaiting_review', 'kept', 'discarded'].includes(props.card.state)
  || reviewExpired(props.card))
// In 计划 and 自动 the other computer sees the summary and file list only once the branch is kept; in 完全信任 it saw them already.
const keepShares = computed(() => actions.value.includes('keep') && props.card.modeAtDecision !== 'trusted')
const yesNo = (value: boolean) => t(value ? 'visitRequests.card.yes' : 'visitRequests.card.no')
</script>

<template>
  <DialogHeader>
    <DialogTitle class="pr-8 text-[18px] font-semibold leading-tight [overflow-wrap:anywhere]" data-visit-title>{{ card.title }}</DialogTitle>
    <DialogDescription class="visit-card-meta">
      <span>{{ askerLine(card.requester) }} · {{ overviewTime(card.createdAt) }}</span>
      <Badge variant="secondary" data-visit-state>{{ visitStateLabel(card) }}</Badge>
    </DialogDescription>
    <div class="visit-card-mode">
      <RequesterModeSelect :requester-key="card.requester.key" :label="card.requester.label" @changed="emit('changed')" />
      <p class="visit-note">{{ t('visitRequests.mode.never') }}</p>
    </div>
  </DialogHeader>

  <section class="visit-section" data-visit-asked-section>
    <h3 class="ui-group-label">{{ t('visitRequests.card.asked') }}</h3>
    <!-- The requester's text is data: interpolated as text, never rendered as HTML or Markdown. -->
    <p class="visit-text" data-visit-asked>{{ shownText(card.what) }}</p>
    <p v-if="card.requesterAreas.length" class="visit-note">
      {{ t('visitRequests.card.areas', { areas: card.requesterAreas.map(shownText).join('、') }) }}
    </p>
  </section>

  <section class="visit-section" data-visit-assessment>
    <h3 class="ui-group-label">{{ t(plan ? 'visitRequests.card.assessment' : 'visitRequests.card.assessmentMissing') }}</h3>
    <template v-if="plan">
      <p class="visit-line">{{ t('visitRequests.card.planAreas', { areas: plan.areas.join('、') }) }}</p>
      <p class="visit-line">{{ plan.risks.length ? t('visitRequests.card.planRisks', { risks: plan.risks.join('；') }) : t('visitRequests.card.planNoRisks') }}</p>
      <p class="visit-line" data-visit-touches>
        {{ t('visitRequests.card.touches', { dependencies: yesNo(plan.dependencyChanges), config: yesNo(plan.configChanges), network: yesNo(plan.network) }) }}
      </p>
      <p class="visit-line">{{ t(`visitRequests.card.size.${plan.size}`) }}</p>
    </template>
    <p v-else-if="card.planError" class="visit-line" data-visit-plan-error>{{ planErrorText(card.planError) }}</p>
  </section>

  <section class="visit-section" data-visit-decision>
    <h3 class="ui-group-label">{{ t('visitRequests.card.decision') }}</h3>
    <p class="visit-line">{{ t('visitRequests.card.modeAtReceipt', { mode: modeName(card.modeAtReceipt) }) }} · {{ decisionText(card) }}</p>
    <p v-if="waitsForConstrainedClient(card)" class="visit-line" data-visit-constrained>{{ t('visitRequests.card.constrainedClient') }}</p>
    <p v-if="ending" class="visit-line" data-visit-ending>{{ ending }}</p>
    <UiDisclosure v-if="checks.length || card.error" :title="t('visitRequests.card.details')" data-visit-details>
      <p v-if="checks.length" class="visit-note">{{ t('visitRequests.card.checks') }}</p>
      <ul v-if="checks.length" class="visit-checks" data-visit-checks>
        <li v-for="(check, index) in checks" :key="`${check.name}-${index}`">
          <span>{{ checkName(check.name) }}</span>
          <Badge :variant="check.ok ? 'success' : 'warning'">{{ t(check.ok ? 'visitRequests.card.checkPassed' : 'visitRequests.card.checkFailed') }}</Badge>
        </li>
      </ul>
      <p v-if="card.error" class="visit-note">{{ t('visitRequests.card.errorCode', { code: card.error }) }}</p>
    </UiDisclosure>
  </section>

  <VisitRequestReview v-if="hasResult" :card="card" />

  <section class="visit-section" data-visit-timeline>
    <h3 class="ui-group-label">{{ t('visitRequests.card.timeline') }}</h3>
    <ol class="visit-events">
      <li v-for="(event, index) in card.events" :key="index">
        <span class="visit-event-time">{{ overviewTime(event.at) }}</span>
        <span>{{ eventText(event) }}</span>
      </li>
    </ol>
  </section>

  <DialogFooter v-if="actions.length" class="visit-card-actions" data-visit-actions>
    <Input v-if="actions.includes('decline')" v-model="reason" size="sm" class="visit-reason" :maxlength="REASON_CHARS"
      :aria-label="t('visitRequests.actions.reason')" :placeholder="t('visitRequests.actions.reason')" data-visit-reason />
    <Button v-for="action in actions" :key="action" size="sm" :variant="ACTION_VARIANT[action]" :disabled="Boolean(busy)"
      :loading="busy === action" :loading-label="t(`visitRequests.pending.${action}`)"
      :title="ACTION_HINT[action] ? t(`visitRequests.actions.${ACTION_HINT[action]}`) : undefined"
      :data-visit-action="action" @click="emit('act', action, reason)">
      {{ t(`visitRequests.actions.${action}`) }}
    </Button>
    <p v-if="keepShares" class="visit-note visit-keep-note" data-visit-keep-shares>{{ t('visitRequests.result.keepShares') }}</p>
  </DialogFooter>
</template>

<style scoped>
.visit-card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.visit-card-mode { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-height: 30px; padding-top: 4px; }
.visit-checks, .visit-events { display: grid; gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
.visit-checks li { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 26px; font-size: var(--text-meta); }
.visit-events li { display: grid; grid-template-columns: 9em minmax(0, 1fr); gap: 10px; font-size: var(--text-meta); }
.visit-event-time { color: var(--color-muted); font-variant-numeric: tabular-nums; }
/* The actions keep their place at the card's foot however long it is. */
.visit-card-actions {
  position: sticky; bottom: -24px; z-index: 1; align-items: center; margin: 0 -24px -24px; padding: 12px 24px 16px;
  border-top: 1px solid var(--color-border); background: var(--color-card);
}
.visit-reason { flex: 1 1 200px; min-width: 0; }
/* Under 保留分支: a full line after the buttons, aligned with them. */
.visit-keep-note { flex-basis: 100%; order: 1; text-align: right; }
</style>
