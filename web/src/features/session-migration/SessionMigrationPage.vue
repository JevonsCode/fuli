<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { ApiError, apiErrorReason } from '@/api/client'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { categoryLabel, confirmationLabel, itemEditPath, sourceLabel, type KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import { projectLabel, sessionRecordsPath } from '@/features/session-records/model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import {
  defaultReason, itemKey, migrationRequest, reconcileChoice,
  type MigrationTarget, type SessionMigrationPreview,
} from './model'
import { applySessionMigration, readSessionMigration } from './session-migration-api'

// A session's batch migration (rec#20 part 2): what the session saved while
// nobody chose a scope waits in its temporary project; here the person moves
// all of it, or the items they keep checked, into the formal project the
// session linked to. Every held item is listed with its content, kind, source
// and confirmation. Only this page's confirm moves anything; an Agent can
// only link here. A batch the Provider refuses because an item changed moves
// nothing: the page reads the list again and marks what changed.
const route = useRoute()
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const sessionId = computed(() => String(route.params.sessionId ?? ''))
const client = computed(() => String(route.query.client ?? ''))
const projectId = computed(() => String(route.query.project ?? ''))
const target = computed<MigrationTarget>(() => ({ spaceId: spaceId.value, sessionId: sessionId.value,
  client: client.value, projectId: projectId.value }))
const linkComplete = computed(() => Boolean(sessionId.value && client.value && projectId.value))
const sessionPath = computed(() => sessionRecordsPath(sessionId.value, { client: client.value }))

const preview = ref<SessionMigrationPreview | null>(null)
const chosen = ref(new Set<string>())
const changed = ref(new Set<string>())
const reason = ref('')
const loading = ref(false)
const error = ref('')
const saving = ref(false)
const notice = ref<{ kind: 'status' | 'alert'; text: string } | null>(null)
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !preview.value))
let requestVersion = 0

const project = computed(() => preview.value ? projectLabel(preview.value.target_project) : projectId.value)
const request = computed(() => preview.value
  ? migrationRequest(target.value, preview.value, chosen.value, reason.value) : null)
const chosenCount = computed(() => request.value?.items.length ?? 0)

// Reads what the session holds now; the choice follows reconcileChoice.
async function load() {
  const current = ++requestVersion
  loading.value = true
  error.value = ''
  try {
    const value = await readSessionMigration(target.value)
    if (current !== requestVersion) return null
    const next = reconcileChoice(preview.value, value, chosen.value)
    chosen.value = next.chosen
    preview.value = value
    if (!reason.value.trim()) reason.value = defaultReason(value)
    return next
  } catch (cause) {
    if (current === requestVersion) error.value = apiErrorReason(cause)
    return null
  } finally {
    if (current === requestVersion) loading.value = false
  }
}

function toggle(item: KnowledgeItemSummary, value: boolean | 'indeterminate') {
  const next = new Set(chosen.value)
  if (value === true) next.add(itemKey(item))
  else next.delete(itemKey(item))
  chosen.value = next
}

const selectAll = () => { chosen.value = new Set(preview.value?.items.map(itemKey) ?? []) }
const selectNone = () => { chosen.value = new Set() }

async function migrate() {
  const body = request.value
  if (!body || saving.value) return
  saving.value = true
  notice.value = null
  const name = project.value
  try {
    const result = await applySessionMigration(body)
    changed.value = new Set()
    notice.value = { kind: 'status', text: t('sessionMigration.moved', { count: result.moved.length, project: name }) }
    await load()
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) {
      const next = await load()
      changed.value = next?.changed ?? new Set()
      notice.value = { kind: 'alert', text: [t('sessionMigration.stale'),
        next?.gone ? t('sessionMigration.gone', { count: next.gone }) : ''].filter(Boolean).join(' ') }
    } else {
      notice.value = { kind: 'alert', text: cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
        ? t('sessionMigration.forbidden') : t('sessionMigration.failed', { error: apiErrorReason(cause) }) }
    }
  } finally {
    saving.value = false
  }
}

watch([spaceId, sessionId, client, projectId], () => {
  preview.value = null
  chosen.value = new Set()
  changed.value = new Set()
  reason.value = ''
  notice.value = null
  if (spaceId.value && linkComplete.value) void load()
}, { immediate: true })
</script>

<template>
  <section class="view [scrollbar-gutter:stable]">
    <div class="mx-auto flex w-full max-w-(--form-max) flex-col gap-4" data-session-migration>
      <BackLink :to="sessionPath" :from="/^\/s\//" class="text-sm">{{ t('sessionMigration.back') }}</BackLink>
      <p v-if="!linkComplete" role="alert" class="m-0 text-sm text-destructive" data-migration-link-missing>
        {{ t('sessionMigration.missingLink') }}
      </p>
      <GrowthLoading v-else-if="showLoading" :label="t('sessionMigration.loading')" />
      <div v-else-if="error && !preview" role="alert" class="grid justify-items-start gap-2">
        <p class="m-0 [overflow-wrap:anywhere]">{{ t('sessionMigration.loadFailed', { error }) }}</p>
        <Button variant="outline" size="sm" @click="load">{{ t('sessionMigration.retry') }}</Button>
      </div>
      <template v-else-if="preview">
        <p class="page-lede m-0 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {{ t('sessionMigration.lede', { project }) }}
        </p>
        <p v-if="notice" :role="notice.kind" class="m-0 rounded-lg border bg-card px-4 py-3 text-sm [overflow-wrap:anywhere]"
          :class="notice.kind === 'status' ? 'border-success' : 'border-warning'" data-migration-notice>
          {{ notice.text }}
        </p>
        <GrowthLoading v-if="loading" variant="compact" :label="t('sessionMigration.rereading')" />
        <p v-else-if="error" role="alert" class="m-0 text-sm text-destructive">{{ t('sessionMigration.loadFailed', { error }) }}</p>
        <p v-if="!preview.items.length" class="ui-empty m-0 rounded-lg border border-dashed bg-card" data-migration-empty>
          {{ t('sessionMigration.empty') }}
        </p>
        <form v-else class="grid gap-4" @submit.prevent="migrate">
          <fieldset class="m-0 grid min-w-0 gap-3 border-0 p-0" :disabled="saving">
            <legend class="ui-sr-only">{{ t('sessionMigration.choose', { project }) }}</legend>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-sm text-muted-foreground tabular-nums" aria-live="polite" data-migration-chosen>
                {{ t('sessionMigration.chosen', { chosen: chosenCount, total: preview.items.length }) }}
              </span>
              <span class="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" data-migration-select-all @click="selectAll">
                  {{ t('sessionMigration.selectAll') }}
                </Button>
                <Button type="button" variant="ghost" size="sm" data-migration-select-none @click="selectNone">
                  {{ t('sessionMigration.selectNone') }}
                </Button>
              </span>
            </div>
            <p v-if="preview.truncated" class="m-0 text-xs text-muted-foreground" data-migration-truncated>
              {{ t('sessionMigration.truncated', { shown: preview.items.length }) }}
            </p>
            <ul class="m-0 grid list-none gap-3 p-0">
              <li v-for="item in preview.items" :key="itemKey(item)" class="min-w-0">
                <!-- A chosen item lifts as a card; there is no side accent. -->
                <div class="flex min-w-0 items-start gap-3 rounded-lg border bg-card p-4 transition-[border-color,box-shadow]"
                  :class="chosen.has(itemKey(item)) ? 'border-border-strong shadow-md' : 'hover:border-border-strong'"
                  :data-migration-item="item.item_id" :data-chosen="chosen.has(itemKey(item))">
                  <Checkbox :id="`migrate-${itemKey(item)}`" class="mt-0.5" :model-value="chosen.has(itemKey(item))"
                    @update:model-value="value => toggle(item, value)" />
                  <div class="grid min-w-0 flex-1 gap-2">
                    <label :for="`migrate-${itemKey(item)}`"
                      class="cursor-pointer text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{{ item.content }}</label>
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">{{ categoryLabel(item) }}</Badge>
                      <Badge :variant="item.content_source === 'user_explicit' ? 'default' : 'outline'">{{ sourceLabel(item) }}</Badge>
                      <Badge :variant="item.confirmation_status === 'pending' ? 'warning' : 'success'">{{ confirmationLabel(item) }}</Badge>
                      <Badge v-if="changed.has(itemKey(item))" variant="warning" data-migration-changed>
                        {{ t('sessionMigration.changed') }}
                      </Badge>
                      <RouterLink :to="itemEditPath(spaceId, item)" class="text-xs text-muted-foreground underline underline-offset-4">
                        {{ t('sessionMigration.open') }}
                      </RouterLink>
                    </div>
                  </div>
                </div>
              </li>
            </ul>
          </fieldset>
          <Field>
            <FieldLabel for="migration-reason">{{ t('sessionMigration.reason') }}</FieldLabel>
            <Input id="migration-reason" v-model="reason" :disabled="saving" maxlength="2000" autocomplete="off" />
            <FieldDescription>{{ reason.trim() ? t('sessionMigration.keepsStatus') : t('sessionMigration.reasonRequired') }}</FieldDescription>
          </Field>
          <p v-if="!chosenCount" class="m-0 text-xs text-muted-foreground" data-migration-none>{{ t('sessionMigration.noneChosen') }}</p>
          <div>
            <Button type="submit" :disabled="!request || loading" :loading="saving"
              :loading-label="t('sessionMigration.confirming', { count: chosenCount, project })" data-migration-confirm>
              {{ t('sessionMigration.confirm', { count: chosenCount, project }) }}
            </Button>
          </div>
        </form>
      </template>
    </div>
  </section>
</template>
