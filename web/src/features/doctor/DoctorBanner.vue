<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiNotice } from '@/ui'
import {
  attentionItems, canRepair, doctorItemView, readDoctor, repairDoctor,
  type DoctorReport, type DoctorRepairResult,
} from './model'

// The shell's one line when FULI's 体检 finds something that needs the
// person: how many things, a list to look at, and 「自动修复」 when some of them
// need no decision. It reads the doctor while the console is open; a failed
// read keeps the last answer, and a first read that fails shows nothing.
const POLL_MS = 60_000

const store = useConsoleStore()
const report = ref<DoctorReport | null>(null)
const open = ref(false)
const repairing = ref(false)
const failure = ref('')
let reading = false
let timer: ReturnType<typeof setInterval> | undefined

const items = computed(() => attentionItems(report.value))
const views = computed(() => items.value.map(item => ({ id: item.id, ...doctorItemView(item) })))
const shown = computed(() => report.value !== null && report.value.overall !== 'ok' && items.value.length > 0)

async function refresh() {
  if (reading || repairing.value || document.visibilityState === 'hidden') return
  reading = true
  try { report.value = await readDoctor() } catch { /* keep the last answer; the next read tries again */ }
  finally { reading = false }
}

// A full success is said in the shell's feedback line; what failed stays
// beside the banner until the next repair.
function announce(results: DoctorRepairResult[]) {
  const failed = results.filter(result => result.outcome === 'failed')
  if (!failed.length) {
    store.notify(t('doctor.repaired', { count: results.filter(result => result.outcome === 'fixed').length }))
    return
  }
  const reason = [...new Set(failed.map(result => result.error ?? ''))].filter(Boolean).join(' ')
  failure.value = t('doctor.repairFailed', { count: failed.length, reason })
}

async function repair() {
  repairing.value = true
  failure.value = ''
  try {
    const answer = await repairDoctor()
    report.value = answer.doctor
    announce(answer.results)
  } catch (error) {
    failure.value = apiErrorReason(error)
  } finally {
    repairing.value = false
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(refresh, POLL_MS)
  document.addEventListener('visibilitychange', refresh)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', refresh)
})
</script>

<template>
  <div v-if="shown || failure" class="doctor-banner" data-doctor-banner>
    <UiNotice v-if="shown" :tone="report?.overall === 'degraded' ? 'warning' : 'info'">
      <p>{{ t('doctor.summary', { count: items.length }) }}</p>
      <ul v-if="open" id="doctor-items" class="doctor-items" :aria-label="t('doctor.listLabel')" data-doctor-items>
        <li v-for="view in views" :key="view.id" :data-doctor-item="view.id">
          <strong>{{ view.title }}</strong><template v-if="view.subject">：{{ view.subject }}</template>
          <span v-if="view.hint" class="doctor-hint">{{ view.hint }}</span>
          <Button v-if="view.to" as-child variant="link" size="sm" class="doctor-link">
            <RouterLink :to="view.to" data-doctor-link>{{ t('doctor.open') }}</RouterLink>
          </Button>
        </li>
      </ul>
      <template #actions>
        <Button size="sm" variant="ghost" :aria-expanded="open" aria-controls="doctor-items" data-doctor-toggle @click="open = !open">
          {{ open ? t('doctor.hide') : t('doctor.show') }}
        </Button>
        <Button v-if="canRepair(items) || repairing" size="sm" variant="outline" :loading="repairing" :loading-label="t('doctor.repairing')"
          data-doctor-repair @click="repair">
          {{ t('doctor.repair') }}
        </Button>
      </template>
    </UiNotice>
    <UiNotice v-if="failure" tone="warning" data-doctor-failure>{{ failure }}</UiNotice>
  </div>
</template>

<style scoped>
.doctor-banner { display: grid; gap: 6px; justify-items: start; }
.doctor-items { display: grid; gap: 4px; margin: 6px 0 0; padding-left: 16px; }
.doctor-hint { display: block; color: var(--color-muted); }
.doctor-link { height: auto; padding: 0; }
</style>
