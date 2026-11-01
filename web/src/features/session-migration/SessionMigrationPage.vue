<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { ApiError, apiErrorReason } from '@/api/client'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import PageColumns from '@/components/PageColumns.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import {
  categoryLabel, confirmationLabel, itemEditPath, knowledgeWorkspaceItemPath, sourceLabel, type KnowledgeItemSummary,
} from '@/features/knowledge-quick-edit/model'
import { projectLabel, sessionRecordsPath } from '@/features/session-records/model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import {
  MAX_MOVE, appendPage, defaultReason, itemKey, migrationRefusal, migrationRequest, reconcileChoice,
  type MigrationTarget, type SessionMigrationPreview,
} from './model'
import { applySessionMigration, readSessionMigration } from './session-migration-api'

// A session's batch migration (rec#20 part 2): what the session saved while
// nobody chose a scope waits in its temporary project; here the person moves
// the items they keep checked into the formal project the session linked to.
// The held items come in pages; any of them can be chosen, and one move takes
// at most 100. Only this page's confirm moves anything; an Agent can only link
// here. A move the Provider refuses moves nothing: an item changed (the page
// reads the list again and marks it) or the target already holds a matching
// item (加入项目 decides). Until a fresh read succeeds, nothing can be sent.
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
const conflicted = ref<KnowledgeItemSummary[]>([])
const reason = ref('')
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const saving = ref(false)
// A refused move left the page showing what may be out of date: no send until a fresh read.
const stale = ref(false)
const notice = ref<{ kind: 'status' | 'alert'; text: string } | null>(null)
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !preview.value))
let requestVersion = 0

const project = computed(() => preview.value ? projectLabel(preview.value.target_project) : projectId.value)
const chosenCount = computed(() => preview.value?.items.filter(item => chosen.value.has(itemKey(item))).length ?? 0)
const request = computed(() => preview.value && !stale.value
  ? migrationRequest(target.value, preview.value, chosen.value, reason.value) : null)
const remaining = computed(() => preview.value ? Math.max(preview.value.held_count - preview.value.items.length, 0) : 0)

// Reads what the session holds now, as many items as were shown (at least one
// page); the choice follows reconcileChoice.
async function load() {
  const current = ++requestVersion
  const wanted = preview.value?.items.length ?? 0
  loading.value = true
  error.value = ''
  try {
    let read: SessionMigrationPreview | null = null
    do {
      read = appendPage(read, await readSessionMigration(target.value, read?.next_offset ?? 0))
    } while (read.next_offset != null && read.items.length < wanted)
    if (current !== requestVersion) return null
    const next = reconcileChoice(preview.value, read, chosen.value)
    chosen.value = next.chosen
    preview.value = read
    stale.value = false
    if (!reason.value.trim()) reason.value = defaultReason(read)
    return next
  } catch (cause) {
    if (current === requestVersion) error.value = apiErrorReason(cause)
    return null
  } finally {
    if (current === requestVersion) loading.value = false
  }
}

// The next page; its items start unchosen and the person's choices stay.
async function loadMore() {
  const loaded = preview.value
  if (!loaded || loaded.next_offset == null || loadingMore.value) return
  loadingMore.value = true
  error.value = ''
  try {
    const read = appendPage(loaded, await readSessionMigration(target.value, loaded.next_offset))
    if (preview.value !== loaded) return
    chosen.value = reconcileChoice(loaded, read, chosen.value).chosen
    preview.value = read
  } catch (cause) {
    error.value = apiErrorReason(cause)
  } finally {
    loadingMore.value = false
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
  conflicted.value = []
  const name = project.value
  const shown = preview.value
  try {
    const result = await applySessionMigration(body)
    refusal = null
    changed.value = new Set()
    notice.value = { kind: 'status', text: t('sessionMigration.moved', { count: result.moved.length, project: name }) }
    await load()
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) await refused(cause, shown, name)
    else {
      notice.value = { kind: 'alert', text: cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
        ? t('sessionMigration.forbidden') : t('sessionMigration.failed', { error: apiErrorReason(cause) }) }
    }
  } finally {
    saving.value = false
  }
}

// Nothing moved. Read again before anything else can be sent, and say whether that read worked.
let refusal: { code: string; lead: string } | null = null

async function refused(cause: ApiError, shown: SessionMigrationPreview | null, name: string) {
  const detail = migrationRefusal(cause.detail)
  const named = new Set(detail.items.map(item => `${item.item_kind}:${item.item_id}`))
  conflicted.value = detail.code === 'project_has_match'
    ? (shown?.items ?? []).filter(item => named.has(itemKey(item))) : []
  refusal = { code: detail.code, lead: detail.code === 'project_has_match'
    ? t('sessionMigration.projectMatch', { project: name }) : t('sessionMigration.stale') }
  stale.value = true
  await reread()
}

// The re-read after a refusal, automatic or from 重新读取: only a read that
// worked lifts the hold, and it marks what changed against the list the
// refused move was made from (still shown until then) and replaces any
// earlier failure notice.
async function reread() {
  const lead = refusal?.lead ?? t('sessionMigration.stale')
  const next = await load()
  if (!next) {
    notice.value = { kind: 'alert', text: `${lead} ${t('sessionMigration.rereadFailed', { error: error.value })}` }
    return
  }
  changed.value = next.changed
  notice.value = { kind: 'alert', text: [lead, refusal?.code === 'project_has_match' ? '' : t('sessionMigration.reread'),
    next.gone ? t('sessionMigration.gone', { count: next.gone }) : ''].filter(Boolean).join(' ') }
}

watch([spaceId, sessionId, client, projectId], () => {
  preview.value = null
  chosen.value = new Set()
  changed.value = new Set()
  conflicted.value = []
  stale.value = false
  refusal = null
  reason.value = ''
  notice.value = null
  if (spaceId.value && linkComplete.value) void load()
}, { immediate: true })
</script>

<template>
  <section class="view">
    <div class="flex w-full flex-col gap-4" data-session-migration>
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
        <div v-if="notice" :role="notice.kind" class="grid justify-items-start gap-2 rounded-lg border bg-card px-4 py-3 text-sm"
          :class="notice.kind === 'status' ? 'border-success' : 'border-warning'" data-migration-notice>
          <p class="m-0 [overflow-wrap:anywhere]">{{ notice.text }}</p>
          <ul v-if="conflicted.length" class="m-0 grid list-none gap-1 p-0" data-migration-conflicts>
            <li v-for="item in conflicted" :key="itemKey(item)" class="[overflow-wrap:anywhere]">
              <RouterLink :to="knowledgeWorkspaceItemPath(spaceId, item)" class="underline underline-offset-4">
                {{ t('sessionMigration.projectMatchAction', { content: item.title }) }}
              </RouterLink>
            </li>
          </ul>
          <Button v-if="stale && !loading" variant="outline" size="sm" data-migration-reread @click="reread">
            {{ t('sessionMigration.rereadAction') }}
          </Button>
        </div>
        <GrowthLoading v-if="loading" variant="compact" :label="t('sessionMigration.rereading')" />
        <p v-else-if="error && !stale" role="alert" class="m-0 text-sm text-destructive">{{ t('sessionMigration.loadFailed', { error }) }}</p>
        <p v-if="!preview.items.length" class="ui-empty m-0 rounded-lg border border-dashed bg-card" data-migration-empty>
          {{ t('sessionMigration.empty') }}
        </p>
        <form v-else class="grid gap-4" @submit.prevent="migrate">
          <fieldset class="m-0 grid min-w-0 gap-3 border-0 p-0" :disabled="saving">
            <legend class="ui-sr-only">{{ t('sessionMigration.choose', { project }) }}</legend>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-sm text-muted-foreground tabular-nums" aria-live="polite" data-migration-chosen>
                {{ t('sessionMigration.chosen', { chosen: chosenCount, total: preview.held_count }) }}
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
            <PageColumns role="list">
              <div v-for="item in preview.items" :key="itemKey(item)" role="listitem" class="min-w-0">
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
                      <Badge v-if="conflicted.some(candidate => itemKey(candidate) === itemKey(item))" variant="warning"
                        data-migration-conflicted>
                        {{ t('sessionMigration.conflicted') }}
                      </Badge>
                      <RouterLink :to="itemEditPath(spaceId, item)" class="text-xs text-muted-foreground underline underline-offset-4">
                        {{ t('sessionMigration.open') }}
                      </RouterLink>
                    </div>
                  </div>
                </div>
              </div>
            </PageColumns>
            <div v-if="preview.next_offset != null" class="flex flex-wrap items-center gap-3" data-migration-more>
              <Button type="button" variant="outline" size="sm" :loading="loadingMore"
                :loading-label="t('sessionMigration.loadingMore')" @click="loadMore">
                {{ t('sessionMigration.loadMore', { count: Math.min(remaining, MAX_MOVE) }) }}
              </Button>
              <span class="text-xs text-muted-foreground">{{ t('sessionMigration.moreHeld', { count: remaining }) }}</span>
            </div>
          </fieldset>
          <Field>
            <FieldLabel for="migration-reason">{{ t('sessionMigration.reason') }}</FieldLabel>
            <Input id="migration-reason" v-model="reason" :disabled="saving" maxlength="2000" autocomplete="off" />
            <FieldDescription>{{ reason.trim() ? t('sessionMigration.keepsStatus') : t('sessionMigration.reasonRequired') }}</FieldDescription>
          </Field>
          <p v-if="!chosenCount" class="m-0 text-xs text-muted-foreground" data-migration-none>
            {{ t('sessionMigration.noneChosen') }}
            <RouterLink :to="sessionPath" class="underline underline-offset-4">{{ t('sessionMigration.backToSession') }}</RouterLink>
          </p>
          <p v-else-if="chosenCount > MAX_MOVE" class="m-0 text-xs text-destructive" data-migration-too-many>
            {{ t('sessionMigration.tooMany', { max: MAX_MOVE, count: chosenCount }) }}
          </p>
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
