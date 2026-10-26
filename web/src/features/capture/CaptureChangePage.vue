<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { ApiError, apiErrorReason, getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { projectDisplayName } from '@/features/projects/project-origin'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { CapturePolicy } from '@/types'
import {
  clientName, settingLabel, settingValue, shortSession, type CaptureChangePreview, type CaptureChangeSetting,
} from './capture-change'

// The person's confirmation of a capture change an Agent asked for (rec#5
// C4-2, rec#11 D-16). Confirm applies it once; a changed, used or expired
// request writes nothing and says to ask again; cancel writes nothing. A link
// that can no longer be used (410) or an answer that never arrived proves
// nothing about an earlier confirm, so the page reads the settings again and
// shows what is saved instead of promising nothing changed (dot review, PR 262).
const route = useRoute()
const store = useConsoleStore()
const previewId = computed(() => String(route.params.previewId ?? ''))

type Outcome = 'saved' | 'cancelled' | 'stale' | 'gone' | 'unknown'
const change = ref<CaptureChangePreview | null>(null)
const loading = ref(true)
const loadError = ref('')
const pending = ref<'confirm' | 'cancel' | null>(null)
const outcome = ref<Outcome | null>(null)
const failure = ref('')
// After a used link or a lost answer the page shows the settings as saved,
// once every save this console sent has answered; until then it says it is
// still reading, and the rows follow the store after that.
const reconciling = ref(false)
const reconciled = ref(false)
const rereadFailed = ref(false)

const projectNames = computed(() => new Map((store.state?.personalProjects ?? [])
  .map(project => [project.project_id, projectDisplayName(project)])))
const projectName = (id: string) => projectNames.value.get(id) ?? id
const value = (setting: CaptureChangeSetting, raw: unknown) => settingValue(setting, raw, projectName)
const CURRENT_SETTINGS: CaptureChangeSetting[] = ['enabled', 'disabledSources', 'capturedSources', 'projectMode', 'unregisteredDirectories']
const projectList = (policy: CapturePolicy) => policy.projectMode === 'selected'
  ? { setting: 'selectedProjectIds' as const, ids: policy.selectedProjectIds ?? [] }
  : policy.projectMode === 'all_except' ? { setting: 'excludedProjectIds' as const, ids: policy.excludedProjectIds ?? [] } : null
const stale = computed(() => outcome.value === 'stale' || (!outcome.value && change.value?.status === 'stale'))
const shownSettings = computed(() => reconciled.value ? store.state?.capturePolicy ?? null
  : outcome.value === 'gone' || outcome.value === 'unknown' ? null : change.value?.current ?? null)
// The settings shown under 当前设置, one row per setting, with the project list the mode uses.
const currentRows = computed(() => {
  const policy = shownSettings.value
  if (!policy) return []
  const projects = projectList(policy)
  return [...CURRENT_SETTINGS.map(setting => ({ label: settingLabel(setting), value: value(setting, policy[setting]) })),
    ...(projects ? [{ label: settingLabel(projects.setting), value: value(projects.setting, projects.ids) }] : [])]
})

async function readSavedSettings() {
  reconciling.value = true
  try {
    await store.settledCapturePolicy()
    reconciled.value = true
  } catch {
    rereadFailed.value = true
  } finally {
    reconciling.value = false
  }
}
const time = (iso: string) => formatDateTime(iso, currentLocale(), DATE_TIME_MINUTE, { missing: '' })

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    change.value = await getJson<CaptureChangePreview>(`/api/capture-changes/${encodeURIComponent(previewId.value)}`)
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
      outcome.value = 'gone'
      // Shown at once; the settings rows follow once every pending save has answered.
      void readSavedSettings()
    } else {
      loadError.value = apiErrorReason(error)
    }
  } finally {
    loading.value = false
  }
}

async function act(action: 'confirm' | 'cancel') {
  if (pending.value) return
  pending.value = action
  failure.value = ''
  try {
    const result = await postJson<CapturePolicy | { status: string }>(
      `/api/capture-changes/${encodeURIComponent(previewId.value)}/${action}`, {})
    if (action === 'confirm') {
      store.rememberCapturePolicy(result as CapturePolicy)
      // The settings shown are now the ones just saved.
      if (change.value) change.value = { ...change.value, current: result as CapturePolicy }
      outcome.value = 'saved'
    } else {
      outcome.value = 'cancelled'
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // The settings changed after the request: the confirm wrote nothing.
      outcome.value = 'stale'
    } else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 404 && error.status !== 410) {
      failure.value = apiErrorReason(error)
    } else {
      // A used link, or an answer that never came: an earlier confirm may have saved.
      outcome.value = error instanceof ApiError && (error.status === 404 || error.status === 410) ? 'gone' : 'unknown'
      failure.value = apiErrorReason(error)
      await readSavedSettings()
    }
  } finally {
    pending.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="capture-change" data-capture-change>
    <GrowthLoading v-if="loading" :label="t('capture.confirm.loading')" />
    <div v-else-if="loadError" class="capture-change-notice" role="alert">
      <p>{{ t('capture.confirm.loadFailed', { reason: loadError }) }}</p>
      <Button variant="outline" size="sm" @click="load">{{ t('capture.confirm.retry') }}</Button>
    </div>
    <template v-else>
      <p v-if="outcome === 'saved'" class="capture-change-notice capture-change-done" role="status" data-capture-change-outcome="saved">
        {{ t('capture.confirm.saved') }}
        <RouterLink to="/settings">{{ t('capture.confirm.openSettings') }}</RouterLink>
      </p>
      <p v-else-if="outcome === 'cancelled'" class="capture-change-notice" role="status" data-capture-change-outcome="cancelled">
        {{ t('capture.confirm.cancelled') }}
      </p>
      <div v-else-if="stale" class="capture-change-notice capture-change-stale" role="alert" data-capture-change-outcome="stale">
        <strong>{{ t('capture.confirm.restart') }}</strong>
        <span>{{ t('capture.confirm.staleHint') }}</span>
      </div>
      <div v-else-if="outcome === 'gone' || outcome === 'unknown'" class="capture-change-notice capture-change-stale" role="alert"
        :data-capture-change-outcome="outcome">
        <strong>{{ t(outcome === 'gone' ? 'capture.confirm.gone' : 'capture.confirm.unknown') }}</strong>
        <span>{{ t(outcome === 'gone' ? 'capture.confirm.goneHint' : 'capture.confirm.unknownHint') }}</span>
        <GrowthLoading v-if="reconciling" variant="inline" :label="t('capture.confirm.reading')" data-capture-change-reading />
        <span v-if="rereadFailed">{{ t('capture.confirm.rereadFailed') }}</span>
        <RouterLink to="/settings" data-capture-change-open-settings>{{ t('capture.confirm.viewSettings') }}</RouterLink>
      </div>

      <Card v-if="!change && reconciled" as="section" aria-labelledby="capture-change-saved-now">
        <CardHeader><CardTitle id="capture-change-saved-now" as="h2">{{ t('capture.confirm.current') }}</CardTitle></CardHeader>
        <dl class="capture-change-list capture-change-body" data-capture-change-current>
          <div v-for="row in currentRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        </dl>
      </Card>

      <Card v-if="change" as="section" aria-labelledby="capture-change-request">
        <CardHeader>
          <CardTitle id="capture-change-request" as="h2">{{ t('capture.confirm.request') }}</CardTitle>
          <CardDescription>
            {{ change.sessionId
              ? t('capture.confirm.askedBySession', { client: clientName(change.sourceApplication), session: shortSession(change.sessionId) })
              : t('capture.confirm.askedBy', { client: clientName(change.sourceApplication) }) }}
            · {{ t('capture.confirm.expires', { time: time(change.expiresAt) }) }}
          </CardDescription>
        </CardHeader>
        <div class="capture-change-body">
          <blockquote class="capture-change-sentence" data-capture-change-preview :title="change.sessionId ?? undefined">
            {{ change.preview }}
          </blockquote>
          <section aria-labelledby="capture-change-diff">
            <h3 id="capture-change-diff" class="capture-change-heading">{{ t('capture.confirm.changes') }}</h3>
            <dl class="capture-change-list">
              <div v-for="item in change.changes" :key="item.setting" :data-capture-change-setting="item.setting">
                <dt>{{ settingLabel(item.setting) }}</dt>
                <dd>
                  <span class="capture-change-before">{{ value(item.setting, item.before) }}</span>
                  <span aria-hidden="true">→</span>
                  <span class="ui-sr-only">{{ t('capture.confirm.becomes') }}</span>
                  <strong>{{ value(item.setting, item.after) }}</strong>
                </dd>
              </div>
            </dl>
          </section>
          <section v-if="currentRows.length" aria-labelledby="capture-change-current">
            <h3 id="capture-change-current" class="capture-change-heading">{{ t('capture.confirm.current') }}</h3>
            <dl class="capture-change-list" data-capture-change-current>
              <div v-for="row in currentRows" :key="row.label">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.value }}</dd>
              </div>
            </dl>
          </section>
          <p class="capture-change-note">{{ t('capture.confirm.note') }}</p>
          <div v-if="!outcome && !stale" class="capture-change-actions">
            <Button :loading="pending === 'confirm'" :loading-label="t('capture.confirm.confirming')"
              :disabled="pending !== null" data-capture-change-confirm @click="act('confirm')">
              {{ t('capture.confirm.confirm') }}
            </Button>
            <Button variant="outline" :loading="pending === 'cancel'" :loading-label="t('capture.confirm.cancelling')"
              :disabled="pending !== null" data-capture-change-cancel @click="act('cancel')">
              {{ t('capture.confirm.cancel') }}
            </Button>
          </div>
          <p v-if="failure && !outcome" class="capture-change-failure" role="alert" data-capture-change-error>
            {{ t('capture.confirm.failed', { reason: failure }) }}
          </p>
        </div>
      </Card>
    </template>
  </div>
</template>

<style scoped>
.capture-change { display: grid; gap: 16px; width: 100%; min-width: 0; max-width: var(--layout-max); margin-inline: auto; }
.capture-change-body { display: grid; gap: 20px; min-width: 0; padding: 0 20px; }
.capture-change-body > section { display: grid; gap: 8px; }
.capture-change-notice { display: grid; gap: 4px; margin: 0; padding: 12px 16px; border: 1px solid var(--color-border);
  border-radius: var(--radius-card); background: var(--color-surface); font-size: 14px; }
.capture-change-notice a { color: var(--color-accent); }
.capture-change-done { border-color: var(--color-success); }
.capture-change-stale { border-color: var(--color-warning); }
.capture-change-stale span { color: var(--color-muted); font-size: 13px; }
.capture-change-sentence { margin: 0; padding: 14px 16px; border-radius: 10px; background: var(--color-surface-subtle);
  font-size: 16px; line-height: 1.7; overflow-wrap: anywhere; }
.capture-change-heading { margin: 0; font-size: 13px; font-weight: 600; color: var(--color-muted); }
.capture-change-list { display: grid; gap: 8px; margin: 0; }
.capture-change-list > div { display: grid; grid-template-columns: minmax(120px, 200px) minmax(0, 1fr); gap: 4px 16px; }
.capture-change-list dt { color: var(--color-muted); font-size: 13px; }
.capture-change-list dd { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.capture-change-before { color: var(--color-muted); text-decoration: line-through; }
.capture-change-note { margin: 0; color: var(--color-muted); font-size: 13px; }
.capture-change-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.capture-change-failure { margin: 0; color: var(--color-danger); font-size: 13px; }
@media (max-width: 520px) {
  .capture-change-list > div { grid-template-columns: minmax(0, 1fr); }
}
</style>
