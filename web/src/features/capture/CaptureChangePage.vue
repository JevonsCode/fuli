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
// request writes nothing and says to ask again; cancel writes nothing.
const route = useRoute()
const store = useConsoleStore()
const previewId = computed(() => String(route.params.previewId ?? ''))

type Outcome = 'saved' | 'cancelled' | 'restart'
const change = ref<CaptureChangePreview | null>(null)
const loading = ref(true)
const loadError = ref('')
const pending = ref<'confirm' | 'cancel' | null>(null)
const outcome = ref<Outcome | null>(null)
const failure = ref('')

const projectNames = computed(() => new Map((store.state?.personalProjects ?? [])
  .map(project => [project.project_id, projectDisplayName(project)])))
const projectName = (id: string) => projectNames.value.get(id) ?? id
const value = (setting: CaptureChangeSetting, raw: unknown) => settingValue(setting, raw, projectName)
const CURRENT_SETTINGS: CaptureChangeSetting[] = ['enabled', 'disabledSources', 'projectMode', 'unregisteredDirectories']
const projectList = (policy: CapturePolicy) => policy.projectMode === 'selected'
  ? { setting: 'selectedProjectIds' as const, ids: policy.selectedProjectIds ?? [] }
  : policy.projectMode === 'all_except' ? { setting: 'excludedProjectIds' as const, ids: policy.excludedProjectIds ?? [] } : null
const stale = computed(() => outcome.value === 'restart' || change.value?.status === 'stale')
const time = (iso: string) => formatDateTime(iso, currentLocale(), DATE_TIME_MINUTE, { missing: '' })

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    change.value = await getJson<CaptureChangePreview>(`/api/capture-changes/${encodeURIComponent(previewId.value)}`)
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 410)) outcome.value = 'restart'
    else loadError.value = apiErrorReason(error)
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
    if (error instanceof ApiError && (error.status === 409 || error.status === 410)) outcome.value = 'restart'
    else failure.value = apiErrorReason(error)
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
      <div v-else-if="stale" class="capture-change-notice capture-change-stale" role="alert" data-capture-change-outcome="restart">
        <strong>{{ t('capture.confirm.restart') }}</strong>
        <span>{{ t('capture.confirm.restartHint') }}</span>
      </div>

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
          <section aria-labelledby="capture-change-current">
            <h3 id="capture-change-current" class="capture-change-heading">{{ t('capture.confirm.current') }}</h3>
            <dl class="capture-change-list">
              <div v-for="setting in CURRENT_SETTINGS" :key="setting">
                <dt>{{ settingLabel(setting) }}</dt>
                <dd>{{ value(setting, change.current[setting]) }}</dd>
              </div>
              <div v-if="projectList(change.current)">
                <dt>{{ settingLabel(projectList(change.current)!.setting) }}</dt>
                <dd>{{ value(projectList(change.current)!.setting, projectList(change.current)!.ids) }}</dd>
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
          <p v-if="failure" class="capture-change-failure" role="alert" data-capture-change-error>
            {{ t('capture.confirm.failed', { reason: failure }) }}
          </p>
        </div>
      </Card>
    </template>
  </div>
</template>

<style scoped>
.capture-change { display: grid; gap: 16px; width: 100%; min-width: 0; max-width: var(--form-max); margin-inline: auto; }
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
