<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import TonborgDelegationSwitch from '@/features/review-list/TonborgDelegationSwitch.vue'
import AdvancedOnly from '@/features/advanced-areas/AdvancedOnly.vue'
import { useConsoleStore } from '@/stores/console'
import { UiDialog } from '@/ui'
import ModelRoleCheck from './ModelRoleCheck.vue'
import ModelRoleHistory from './ModelRoleHistory.vue'
import ModelRoleTrust from './ModelRoleTrust.vue'
import type { ModelDetailsPart } from './details-link'
import { roleName, type ModelRoleView, type ModelRolesPayload } from './model'
import { useAdvice, useGuideUrl } from './model-uses'
import { roleFacts, showsTrust } from './role-details'

// 「查看详情」 of one use: what is enough (with the website guide), the facts
// of its settings, how its automatic operation runs, its change history, and
// the connection test. Editing closes this and opens the form.
const props = defineProps<{ view: ModelRoleView | null; payload: ModelRolesPayload; historyVersion: number; linkedPart?: ModelDetailsPart | null }>()
const emit = defineEmits<{ close: []; edit: []; trustSaved: [payload: ModelRolesPayload]; changed: [] }>()

const locale = computed(() => currentLocale())
const name = computed(() => (props.view ? roleName(props.view.role) : ''))
const facts = computed(() => (props.view ? roleFacts(props.view, props.payload, locale.value) : []))
// 「交给 Tonborg 确认」 (rec#96) runs on this model; turning it on also changes its execution mode.
const spaceId = computed(() => useConsoleStore().activePersonalSpace?.id ?? '')
// A link about the switch (from 待决策) scrolls to it and rings it while the details stay open.
const delegation = ref<{ $el?: Element } | null>(null)
watch([() => props.view?.role, () => props.linkedPart, delegation], async ([, part]) => {
  if (part !== 'delegation') return
  await nextTick()
  delegation.value?.$el?.scrollIntoView?.({ block: 'center' })
}, { flush: 'post' })
</script>

<template>
  <UiDialog :open="Boolean(view)" :title="name" size="lg" data-model-use-details @close="emit('close')">
    <div v-if="view" class="model-details" :data-model-role-details-of="view.role">
      <p class="model-details-advice">
        <span class="model-details-label">{{ t('modelSettings.uses.advicePrefix') }}</span>{{ useAdvice(view.role) }}
        <a :href="useGuideUrl(view.role, locale)" target="_blank" rel="noopener noreferrer" data-model-guide>{{ t('modelSettings.guide') }}</a>
      </p>
      <dl class="model-details-facts" :aria-label="name">
        <div v-for="fact in facts" :key="fact.key" :data-model-fact="fact.key">
          <dt>{{ fact.label }}</dt>
          <dd :title="fact.title"><code v-if="fact.code">{{ fact.value }}</code><template v-else>{{ fact.value }}</template></dd>
        </div>
      </dl>
      <AdvancedOnly area="tonborg">
        <TonborgDelegationSwitch v-if="view.role === 'tonborg' && spaceId" ref="delegation" class="model-details-delegation" :personal-space-id="spaceId"
          :data-model-details-linked="linkedPart === 'delegation' ? '' : undefined" @changed="emit('changed')" />
      </AdvancedOnly>
      <ModelRoleTrust v-if="view.trust && showsTrust(view)" :role="view.role" :trust="view.trust"
        :model="view.connection?.model ?? null" @saved="next => emit('trustSaved', next)" @changed="emit('changed')" />
      <ModelRoleHistory :role="view.role" :version="historyVersion" />
    </div>
    <template #footer>
      <ModelRoleCheck v-if="view?.connection" class="model-details-check" :role="view.role" :model="view.connection.model" />
      <Button variant="outline" size="sm" :disabled="payload.state === 'invalid'" data-model-details-edit @click="emit('edit')">
        {{ t('modelSettings.edit') }}
      </Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.model-details { display: grid; gap: var(--space-4); min-width: 0; }
.model-details-delegation { justify-items: start; }
.model-details-delegation :deep(.tonborg-delegation__hint) { text-align: left; }
/* The part a link pointed at, ringed without moving anything (as a linked settings card). */
.model-details-delegation[data-model-details-linked] { border-radius: var(--radius-control); outline: 2px solid var(--ring); outline-offset: 6px; }
.model-details-advice { margin: 0; color: var(--color-ink-soft); font-size: var(--text-body); }
.model-details-advice a { margin-inline-start: 8px; }
.model-details-label { margin-inline-end: 8px; color: var(--color-muted); font-size: var(--text-meta); }
/* One uniform two-column list: label, then value. */
.model-details-facts { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: 8px 20px; margin: 0; font-size: var(--text-body); }
.model-details-facts div { display: contents; }
.model-details-facts dt { color: var(--color-muted); }
.model-details-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.model-details-facts code { color: var(--color-ink); font-family: var(--font-mono); font-size: var(--text-control); overflow-wrap: anywhere; }
.model-details-check { flex: 1; min-width: 0; }
@media (max-width: 520px) {
  .model-details-facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .model-details-facts div + div dt { margin-top: 10px; }
}
</style>
