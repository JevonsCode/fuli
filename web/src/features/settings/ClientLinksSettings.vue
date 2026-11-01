<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { useClientLinks } from '@/features/client-links/client-links-store'

// The client link manifest: its version, 「检查更新」 with a diff, one-click apply,
// the daily auto-update switch and what each update changed.
const links = useClientLinks()
const loadError = ref('')
const checking = ref(false)
const applying = ref(false)
const actionError = ref('')

const state = computed(() => links.state)
const check = computed(() => links.lastCheck)
const update = computed(() => check.value?.status === 'update_available' ? check.value : null)
const time = (value: string | null) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '-' })

onMounted(() => {
  links.load({ force: true }).catch(error => { loadError.value = apiErrorReason(error, t('clientLinks.loadError')) })
})

async function runCheck() {
  checking.value = true
  actionError.value = ''
  try {
    await links.check()
  } catch (error) {
    actionError.value = apiErrorReason(error, t('clientLinks.loadError'))
  } finally {
    checking.value = false
  }
}

async function apply(digest: string) {
  applying.value = true
  actionError.value = ''
  try {
    await links.apply(digest)
  } catch (error) {
    actionError.value = apiErrorReason(error, t('clientLinks.applyError'))
  } finally {
    applying.value = false
  }
}

async function setAutoUpdate(enabled: boolean) {
  actionError.value = ''
  try {
    await links.setAutoUpdate(enabled)
  } catch (error) {
    actionError.value = apiErrorReason(error, t('clientLinks.autoUpdateError'))
  }
}
</script>

<template>
  <Card as="section" id="client-links" class="settings-card client-links-settings" aria-labelledby="client-links-title" data-client-links-settings>
    <CardHeader>
      <CardTitle id="client-links-title" as="h2">{{ t('clientLinks.title') }}</CardTitle>
      <CardDescription>{{ t('clientLinks.description') }}</CardDescription>
      <CardAction>
        <Button type="button" size="sm" variant="outline" :disabled="!state" :loading="checking" :loading-label="t('clientLinks.checking')"
          data-client-links-check @click="runCheck">
          {{ t('clientLinks.check') }}
        </Button>
      </CardAction>
    </CardHeader>
    <div class="client-links-body">
      <GrowthLoading v-if="!state && !loadError" variant="compact" :label="t('clientLinks.loading')" />
      <p v-if="loadError" role="alert">{{ loadError }}</p>
      <template v-if="state">
        <p class="client-links-version" data-client-links-version>
          {{ t('clientLinks.version', { version: state.manifest.manifestVersion, date: state.manifest.updatedAt }) }}
          · {{ state.source === 'updated' ? t('clientLinks.sourceUpdated') : t('clientLinks.sourceBundled') }}
          · {{ state.lastCheckedAt ? t('clientLinks.lastChecked', { time: time(state.lastCheckedAt) }) : t('clientLinks.neverChecked') }}
        </p>

        <div class="client-links-row">
          <span><strong>{{ t('clientLinks.autoUpdate') }}</strong><small>{{ t('clientLinks.autoUpdateHint') }}</small></span>
          <Switch :model-value="state.autoUpdate" :aria-label="t('clientLinks.autoUpdate')" data-client-links-auto
            @update:model-value="setAutoUpdate" />
        </div>

        <section v-if="check" class="client-links-check" data-client-links-result :data-status="check.status" role="status">
          <p v-if="check.status === 'up_to_date'">{{ t('clientLinks.upToDate', { version: check.manifestVersion }) }}</p>
          <p v-else-if="check.status === 'unavailable'">{{ t('clientLinks.unavailable', { reason: check.reason }) }}</p>
          <p v-else-if="check.status === 'invalid'" class="client-links-invalid">{{ t('clientLinks.invalid', { reason: check.reason }) }}</p>
          <template v-else-if="update">
            <p>{{ t('clientLinks.available', { from: update.diff.fromVersion, to: update.diff.toVersion, date: update.updatedAt }) }}</p>
            <dl class="client-links-diff">
              <div v-if="update.diff.added.length" data-client-links-diff="added">
                <dt>{{ t('clientLinks.added') }}</dt>
                <dd v-for="item in update.diff.added" :key="item.id">{{ item.name }}</dd>
              </div>
              <div v-if="update.diff.changed.length" data-client-links-diff="changed">
                <dt>{{ t('clientLinks.changed') }}</dt>
                <dd v-for="item in update.diff.changed" :key="item.id">
                  {{ item.name }}
                  <small> · {{ item.fields.map((field: string) => t(`clientLinks.fields.${field}`)).join(' · ') }}</small>
                </dd>
              </div>
              <div v-if="update.diff.removed.length" data-client-links-diff="removed">
                <dt>{{ t('clientLinks.removed') }}</dt>
                <dd v-for="item in update.diff.removed" :key="item.id">{{ item.name }}</dd>
              </div>
            </dl>
            <Button type="button" size="sm" :loading="applying" :loading-label="t('clientLinks.applying')" data-client-links-apply
              @click="apply(update.digest)">
              {{ t('clientLinks.apply') }}
            </Button>
          </template>
        </section>
        <p v-if="actionError" role="alert">{{ actionError }}</p>

        <section class="client-links-group" aria-labelledby="client-links-clients">
          <h3 id="client-links-clients" class="ui-group-label">{{ t('clientLinks.clients') }}</h3>
          <ul>
            <li v-for="client in state.manifest.clients" :key="client.id" :data-client-link="client.id">
              <strong>{{ client.name }}</strong>
              <span v-if="client.sessionLinks.length">
                {{ client.sessionLinks.map(link => t('clientLinks.opens', { app: link.opens })).join(' · ') }}
              </span>
              <span v-else class="client-links-muted" :title="client.noSessionLink ?? undefined">{{ t('clientLinks.noLink') }}</span>
            </li>
          </ul>
        </section>

        <section v-if="state.history.length" class="client-links-group" aria-labelledby="client-links-history">
          <h3 id="client-links-history" class="ui-group-label">{{ t('clientLinks.history') }}</h3>
          <ul>
            <li v-for="item in state.history" :key="item.appliedAt">
              {{ t('clientLinks.historyItem', { time: time(item.appliedAt), from: item.fromVersion, to: item.toVersion }) }}
              · {{ item.automatic ? t('clientLinks.automatic') : t('clientLinks.manual') }}
            </li>
          </ul>
        </section>
      </template>
    </div>
  </Card>
</template>

<style scoped>
.client-links-body { display: grid; gap: var(--space-3); padding-inline: 24px; font-size: var(--text-meta); }
.client-links-body p { margin: 0; color: var(--color-muted); }
.client-links-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.client-links-row > span { display: grid; min-width: 0; gap: 4px; }
.client-links-row strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.client-links-row small, .client-links-muted { color: var(--color-muted); }
.client-links-check { display: grid; gap: 8px; justify-items: start; }
.client-links-body .client-links-invalid { color: var(--color-danger); }
.client-links-diff { display: grid; gap: 8px; margin: 0; }
.client-links-diff dt { color: var(--color-ink); font-weight: var(--weight-medium); }
.client-links-diff dd { margin: 0; }
.client-links-group { display: grid; gap: 8px; }
.client-links-group ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.client-links-group li { display: flex; flex-wrap: wrap; gap: 8px; }
.client-links-group strong { color: var(--color-ink); font-weight: var(--weight-medium); }
</style>
