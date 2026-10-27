<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  applyMigrationPlan, moreRecords, pruneAgain, pruneAuditError, pruneCheckOutcome, pruneUnverified, readMigrationPlan, refusalCode,
  refusalMessage, sampleChips, shortDigest, undoMigration, type ApplyOutcome, type MigrationPlan, type MigrationResult,
  type UndoableMigration,
} from '@/features/data-format/model'
import StoreRestore from '@/features/data-format/StoreRestore.vue'
import { t } from '@/i18n'
import { UiEmpty, UiNotice } from '@/ui'

// 数据格式迁移 (rec#17 D-09 part 2): one confirm screen. Each store waiting for
// a person is a card with its step, versions, record count and sample IDs;
// one confirmation applies exactly the plan whose digest is shown. The server
// checks it again under each store's lock: a changed plan is read again and
// confirmed again. Undo is per migration; a whole-store restore restarts FULI
// around it (StoreRestore). An unverified graph prune is checked by pruning again.
const plan = ref<MigrationPlan | null>(null)
const loading = ref(true)
const loadError = ref('')
const reviewed = ref(false)
const applying = ref(false)
const stale = ref(false)
const applyError = ref('')
const outcome = ref<ApplyOutcome | null>(null)
const undoTarget = ref<UndoableMigration | null>(null)
const undoing = ref<UndoableMigration | null>(null)
const undoMessage = ref('')
const undoError = ref('')
// The graph's delete was sent after the change, and its answer never came.
const pruneUnknown = ref(false)
// The local operations log could not record that prune; its result stands.
const auditFailure = ref('')
const checkingPrune = ref(false)
const pruneCheck = ref<{ kind: 'unreached' | 'checked'; count: number } | null>(null)
const pruneCheckError = ref('')
let reading: AbortController | null = null
const openedFromSettings = /^\/settings(?:[?#]|$)/

const stores = computed(() => plan.value?.stores ?? [])
const blocked = computed(() => plan.value?.blocked ?? [])
const undoable = computed(() => plan.value?.undoable ?? [])
const warnings = computed(() => stores.value.filter(store => store.warning))
const retention = computed(() => {
  const policy = plan.value?.retention
  return policy ? { keep: policy.keep, megabytes: Math.round(policy.maxBytes / (1024 * 1024)) } : null
})

async function load() {
  reading?.abort()
  reading = new AbortController()
  loading.value = true
  loadError.value = ''
  try {
    plan.value = await readMigrationPlan(reading.signal)
    reviewed.value = false
  } catch (cause) {
    if ((cause as Error)?.name !== 'AbortError') loadError.value = refusalMessage(cause)
  } finally {
    loading.value = false
  }
}

async function apply() {
  const digest = plan.value?.digest
  if (!digest || !reviewed.value) return
  applying.value = true
  applyError.value = ''
  stale.value = false
  outcome.value = null
  pruneUnknown.value = false
  auditFailure.value = ''
  try {
    outcome.value = await applyMigrationPlan(digest)
    pruneUnknown.value = pruneUnverified(outcome.value.pruned)
    auditFailure.value = pruneAuditError(outcome.value.pruned)
    await load()
  } catch (cause) {
    if (refusalCode(cause) === 'data_format_stale_preview') {
      stale.value = true
      await load()
    } else {
      applyError.value = refusalMessage(cause)
    }
  } finally {
    applying.value = false
  }
}

function resultText(result: MigrationResult) {
  if (result.status === 'applied') return t('dataFormat.resultApplied', { id: result.migrationId })
  if (result.status === 'already_applied') return t('dataFormat.resultAlready', { id: result.migrationId })
  return t('dataFormat.resultFailed', { message: result.message ?? result.code ?? '' })
}

async function confirmUndo(entry: UndoableMigration) {
  undoing.value = entry
  undoError.value = ''
  undoMessage.value = ''
  pruneUnknown.value = false
  auditFailure.value = ''
  try {
    const result = await undoMigration(entry.label, entry.migrationId)
    pruneUnknown.value = pruneUnverified(result.pruned)
    auditFailure.value = pruneAuditError(result.pruned)
    undoMessage.value = t('dataFormat.undone', { id: entry.migrationId, version: result.version })
    undoTarget.value = null
    await load()
  } catch (cause) {
    undoError.value = refusalMessage(cause)
  } finally {
    undoing.value = null
  }
}

async function checkPrune() {
  checkingPrune.value = true
  pruneCheck.value = null
  pruneCheckError.value = ''
  try {
    const { pruned } = await pruneAgain()
    const checked = pruneCheckOutcome(pruned)
    pruneUnknown.value = checked.kind === 'unverified'
    pruneCheck.value = checked.kind === 'unverified' ? null : { kind: checked.kind, count: checked.count }
    auditFailure.value = pruneAuditError(pruned)
  } catch (cause) {
    pruneCheckError.value = refusalMessage(cause)
  } finally {
    checkingPrune.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => reading?.abort())
</script>

<template>
  <section class="view data-format-view" :aria-label="t('dataFormat.title')">
    <div class="data-format-content">
      <BackLink to="/settings" :from="openedFromSettings">{{ t('dataFormat.back') }}</BackLink>
      <p class="data-format-lede">{{ t('dataFormat.lede') }}</p>

      <GrowthLoading v-if="loading && !plan" :label="t('dataFormat.loading')" />
      <Card v-else-if="loadError && !plan" as="section" class="data-format-card" role="alert">
        <div class="data-format-body">
          <p>{{ t('dataFormat.loadFailed') }} {{ loadError }}</p>
          <Button variant="outline" @click="load">{{ t('dataFormat.retry') }}</Button>
        </div>
      </Card>

      <template v-else-if="plan">
        <UiNotice v-if="stale" tone="error">{{ t('dataFormat.stale') }}</UiNotice>
        <section v-if="outcome" class="data-format-results" :aria-label="t('dataFormat.results')" role="status">
          <p v-for="result in outcome.results" :key="result.label" :data-result="result.status">
            <strong>{{ result.label }}</strong> {{ resultText(result) }}
          </p>
          <p v-for="skipped in outcome.skipped" :key="skipped.label">
            <strong>{{ skipped.label }}</strong> {{ t('dataFormat.resultSkipped', { id: skipped.migrationId }) }}
          </p>
        </section>

        <div v-if="pruneUnknown" class="data-format-prune" data-prune-unverified>
          <p class="data-format-error" role="alert">{{ t('dataFormat.pruneUnverified') }}</p>
          <Button variant="outline" data-prune-check :loading="checkingPrune" :loading-label="t('dataFormat.pruneChecking')"
            @click="checkPrune">
            {{ t('dataFormat.pruneCheck') }}
          </Button>
        </div>
        <p v-if="pruneCheck" role="status" data-prune-checked>
          {{ pruneCheck.kind === 'checked' ? t('dataFormat.pruneChecked', { count: pruneCheck.count }) : t('dataFormat.pruneUnreached') }}
        </p>
        <p v-if="pruneCheckError" class="data-format-error" role="alert">{{ pruneCheckError }}</p>
        <p v-if="auditFailure" class="data-format-error" role="alert" data-audit-failed>
          {{ t('dataFormat.auditFailed', { message: auditFailure }) }}
        </p>

        <UiEmpty v-if="!stores.length && !blocked.length" icon="check" :text="t('dataFormat.nothingPending')" />

        <Card v-for="store in stores" :key="store.label" as="article" class="data-format-card" data-store-plan
          :aria-labelledby="`plan-${store.store}`">
          <CardHeader>
            <CardTitle :id="`plan-${store.store}`" as="h2" class="data-format-store">
              <span>{{ store.label }}</span>
              <Badge variant="outline">{{ t(`dataFormat.kinds.${store.kind}`) }}</Badge>
            </CardTitle>
            <CardDescription>{{ store.step.summary }}</CardDescription>
          </CardHeader>
          <dl class="data-format-facts data-format-body">
            <div><dt>{{ t('dataFormat.step') }}</dt><dd><code>{{ store.step.id }}</code></dd></div>
            <div><dt>{{ t('dataFormat.version') }}</dt><dd>{{ store.step.fromVersion }} → {{ store.step.toVersion }}</dd></div>
            <div><dt>{{ t('dataFormat.records') }}</dt><dd>{{ t('dataFormat.recordCount', { count: store.step.count }) }}</dd></div>
            <div class="data-format-samples">
              <dt>{{ t('dataFormat.samples') }}</dt>
              <dd>
                <code v-for="chip in sampleChips(store.step)" :key="chip.id" :title="chip.id" class="data-format-chip">
                  {{ chip.text }}<span v-if="chip.cut" aria-hidden="true">…</span>
                </code>
                <span v-if="moreRecords(store.step)" class="data-format-more">{{ t('dataFormat.more', { count: moreRecords(store.step) }) }}</span>
              </dd>
            </div>
            <div v-if="store.automatic.length"><dt>{{ t('dataFormat.runsFirst') }}</dt><dd><code>{{ store.automatic.join(', ') }}</code></dd></div>
            <div><dt>{{ t('dataFormat.undo') }}</dt><dd>{{ store.undo === 'available' ? t('dataFormat.undoAvailable') : t('dataFormat.undoRestoreOnly') }}</dd></div>
            <div><dt>{{ t('dataFormat.backup') }}</dt><dd>{{ store.kind === 'neo4j' ? t('dataFormat.backupJournal') : t('dataFormat.backupFile') }}</dd></div>
          </dl>
          <p v-if="store.warning" class="data-format-warning data-format-body" data-store-warning>{{ store.warning }}</p>
        </Card>

        <Card v-if="blocked.length" as="section" class="data-format-card" aria-labelledby="data-format-blocked">
          <CardHeader><CardTitle id="data-format-blocked" as="h2">{{ t('dataFormat.blockedTitle') }}</CardTitle></CardHeader>
          <ul class="data-format-blocked data-format-body">
            <li v-for="store in blocked" :key="store.label">
              <strong>{{ store.label }}</strong>
              <code v-if="store.steps.length">{{ store.steps.join(', ') }}</code>
              <span>{{ store.reason }}</span>
            </li>
          </ul>
        </Card>

        <Card v-if="plan.digest" as="section" class="data-format-card data-format-confirm" aria-labelledby="data-format-confirm">
          <CardHeader>
            <CardTitle id="data-format-confirm" as="h2">{{ t('dataFormat.confirmTitle') }}</CardTitle>
            <CardDescription>{{ t('dataFormat.digestNote') }}</CardDescription>
          </CardHeader>
          <div class="data-format-body">
          <!-- Said before the confirm control: what no undo can bring back. -->
          <ul v-if="warnings.length" class="data-format-warnings" data-confirm-warnings>
            <li v-for="store in warnings" :key="store.label"><strong>{{ store.label }}</strong> {{ store.warning }}</li>
          </ul>
          <p class="data-format-digest">
            <span>{{ t('dataFormat.digest') }}</span>
            <code :title="plan.digest" data-plan-digest>{{ shortDigest(plan.digest) }}…</code>
          </p>
          <p class="data-format-external" data-external-writers>{{ t('dataFormat.externalWriters') }}</p>
          <div class="data-format-check">
            <Checkbox id="data-format-reviewed" v-model="reviewed" :disabled="applying" />
            <Label for="data-format-reviewed">{{ t('dataFormat.reviewed') }}</Label>
          </div>
          <p class="data-format-presence">{{ t('dataFormat.presence') }}</p>
          <p v-if="applyError" class="data-format-error" role="alert">{{ applyError }}</p>
          <div class="data-format-actions">
            <Button data-apply :disabled="!reviewed" :loading="applying" :loading-label="t('dataFormat.applying')"
              @click="apply">
              {{ t('dataFormat.apply') }}
            </Button>
          </div>
          </div>
        </Card>

        <Card v-if="undoable.length" as="section" class="data-format-card" aria-labelledby="data-format-undo">
          <CardHeader>
            <CardTitle id="data-format-undo" as="h2">{{ t('dataFormat.undoTitle') }}</CardTitle>
            <CardDescription>{{ t('dataFormat.undoLede') }}</CardDescription>
          </CardHeader>
          <div class="data-format-body">
          <p class="data-format-external" data-external-writers>{{ t('dataFormat.externalWriters') }}</p>
          <ul class="data-format-undo">
            <li v-for="entry in undoable" :key="`${entry.label}:${entry.migrationId}`">
              <span><strong>{{ entry.label }}</strong> <code>{{ entry.migrationId }}</code>
                {{ entry.toVersion }} → {{ entry.fromVersion }}</span>
              <span v-if="entry.reversible === false">{{ t('dataFormat.undoRestoreOnly') }}</span>
              <span v-else-if="undoTarget === entry" class="data-format-actions">
                <Button variant="destructive" data-confirm-undo :loading="undoing === entry"
                  :loading-label="t('dataFormat.undoing', { id: entry.migrationId })" @click="confirmUndo(entry)">
                  {{ t('dataFormat.undoConfirm') }}
                </Button>
                <Button variant="ghost" :disabled="undoing === entry" @click="undoTarget = null">{{ t('dataFormat.undoCancel') }}</Button>
              </span>
              <Button v-else variant="outline" data-undo @click="undoTarget = entry">{{ t('dataFormat.undo') }}</Button>
            </li>
          </ul>
          <p v-if="undoMessage" role="status">{{ undoMessage }}</p>
          <p v-if="undoError" class="data-format-error" role="alert">{{ undoError }}</p>
          </div>
        </Card>

        <p v-if="retention" class="data-format-restore" data-retention>
          {{ t('dataFormat.retention', retention) }}
        </p>
        <StoreRestore @restored="load" />
      </template>
    </div>
  </section>
</template>

<style scoped>
.data-format-view {
  padding-top: clamp(16px, 3vw, 32px);
  padding-bottom: 96px;
  color: var(--color-ink);
}

.data-format-content {
  width: 100%;
  max-width: var(--layout-max);
  display: grid;
  gap: 16px;
  margin: 0 auto;
}

.data-format-lede,
.data-format-restore,
.data-format-presence,
.data-format-external {
  margin: 0;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.6;
}

.data-format-store {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  overflow-wrap: anywhere;
}

.data-format-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 12px 24px;
  margin: 0;
}

/* The card's own inset (CardHeader's), for what follows the header. */
.data-format-body {
  display: grid;
  gap: 16px;
  padding-inline: 20px;
}

.data-format-facts div { min-width: 0; }
.data-format-samples { grid-column: 1 / -1; }

.data-format-facts dt {
  color: var(--color-muted);
  font-size: 12px;
}

.data-format-facts dd {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}

code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.data-format-chip {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-surface-subtle);
}

.data-format-more { color: var(--color-muted); font-size: 13px; }

.data-format-blocked,
.data-format-undo {
  display: grid;
  gap: 12px;
  margin: 0;
  padding-block: 0;
  list-style: none;
}

.data-format-undo { padding-inline: 0; }

.data-format-blocked li,
.data-format-undo li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  min-width: 0;
}

.data-format-blocked li span { flex-basis: 100%; color: var(--color-muted); font-size: 13px; }

.data-format-digest {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
}

.data-format-check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.data-format-prune {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.data-format-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.data-format-results {
  margin: 0;
  padding: 12px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  font-size: 14px;
}

.data-format-results p { margin: 0; }
.data-format-error { margin: 0; color: var(--color-danger); font-size: 14px; }

.data-format-warning,
.data-format-warnings {
  margin: 0;
  color: var(--color-danger);
  font-size: 13.5px;
  line-height: 1.6;
}

.data-format-warnings {
  display: grid;
  gap: 6px;
  padding: 0;
  list-style: none;
}
</style>
