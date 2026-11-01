<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import {
  attentionItems, canRepair, doctorItemView, outdatedSessions, portsMovedNotice, readDoctor, repairDoctor,
  type DoctorReport, type DoctorRepairResult,
} from './model'
import DoctorOutdatedSessions from './DoctorOutdatedSessions.vue'

// The shell's chip when FULI's 体检 finds something that needs the person:
// how many things, and a panel with the list and 「自动修复」 when some of them
// need no decision. It reads the doctor while the console is open; a failed
// read keeps the last answer, and a first read that fails shows nothing.
const POLL_MS = 60_000
// The last port move this browser was told about (the doctor's ports_moved id).
const PORT_MOVE_STORAGE_KEY = 'fuli.doctor.port-move'

const store = useConsoleStore()
const report = ref<DoctorReport | null>(null)
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const repairing = ref(false)
const failure = ref('')
let reading = false
let announcedPortMove = ''
let timer: ReturnType<typeof setInterval> | undefined

const items = computed(() => attentionItems(report.value))
const views = computed(() => items.value.map(item => ({ id: item.id, ...doctorItemView(item), sessions: outdatedSessions(item) })))
const shown = computed(() => report.value !== null && report.value.overall !== 'ok' && items.value.length > 0)

async function refresh() {
  if (reading || repairing.value || document.visibilityState === 'hidden') return
  reading = true
  try {
    report.value = await readDoctor()
    announcePortMove(report.value)
  } catch { /* keep the last answer; the next read tries again */ }
  finally { reading = false }
}

// FULI moved a port by itself when it started: said once in the shell's
// feedback line, not again on the next read or the next visit.
function announcePortMove(answer: DoctorReport) {
  const notice = portsMovedNotice(answer)
  if (!notice || notice.id === announcedPortMove) return
  announcedPortMove = notice.id
  try {
    if (window.localStorage.getItem(PORT_MOVE_STORAGE_KEY) === notice.id) return
    window.localStorage.setItem(PORT_MOVE_STORAGE_KEY, notice.id)
  } catch { /* storage unavailable: this page still says it only once */ }
  store.notify(notice.message)
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

// A click outside the chip and its panel closes the panel.
function closeOutside(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  void refresh()
  document.addEventListener('pointerdown', closeOutside)
  timer = setInterval(refresh, POLL_MS)
  document.addEventListener('visibilitychange', refresh)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', refresh)
  document.removeEventListener('pointerdown', closeOutside)
})
</script>

<template>
  <!-- A chip in the top bar, never a row that pushes the page down: the list
       and 自动修复 open in a panel floating below it (Esc or a click outside closes it). -->
  <div v-if="shown || failure" ref="root" class="doctor-banner" data-doctor-banner @keydown.esc="open = false">
    <button type="button" class="doctor-chip" :class="{ 'is-warning': failure || report?.overall === 'degraded' }"
      :aria-expanded="open" aria-controls="doctor-panel" data-doctor-toggle @click="open = !open">
      <span class="doctor-dot" aria-hidden="true" />
      <span>{{ shown ? t('doctor.summary', { count: items.length }) : t('doctor.repairFailedShort') }}</span>
    </button>
    <div v-if="open" id="doctor-panel" class="doctor-panel" role="dialog" :aria-label="t('doctor.listLabel')" data-doctor-panel>
      <ul v-if="shown" class="doctor-items" data-doctor-items>
        <li v-for="view in views" :key="view.id" :data-doctor-item="view.id">
          <strong>{{ view.title }}</strong><template v-if="view.subject">：{{ view.subject }}</template>
          <span v-if="view.hint" class="doctor-hint">{{ view.hint }}</span>
          <DoctorOutdatedSessions v-if="view.sessions.length" :sessions="view.sessions" />
          <Button v-if="view.to" as-child variant="link" size="sm" class="doctor-link">
            <RouterLink :to="view.to" data-doctor-link @click="open = false">{{ t('doctor.open') }}</RouterLink>
          </Button>
        </li>
      </ul>
      <p v-if="failure" class="doctor-failure" role="alert" data-doctor-failure>{{ failure }}</p>
      <div v-if="shown && (canRepair(items) || repairing)" class="doctor-actions">
        <Button size="sm" variant="outline" :loading="repairing" :loading-label="t('doctor.repairing')" data-doctor-repair @click="repair">
          {{ t('doctor.repair') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.doctor-banner { position: relative; }
.doctor-chip {
  display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid var(--edge-glass);
  border-radius: var(--radius-pill); color: var(--color-ink-soft); background: var(--surface-glass); font: inherit; font-size: 13px;
  white-space: nowrap; cursor: pointer; transition: color var(--motion-fast), background var(--motion-fast);
}
.doctor-chip:hover, .doctor-chip[aria-expanded='true'] { color: var(--color-ink); background: var(--color-surface-hover); }
.doctor-chip:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* A warm gold dot says something waits for the person (Jevons, 11-01: 黄色的点点); ink would read as decoration. */
.doctor-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-gold); box-shadow: 0 0 0 3px var(--color-gold-soft); }
.doctor-chip.is-warning .doctor-dot { background: var(--color-warning); box-shadow: 0 0 0 3px var(--color-warning-soft); }
.doctor-panel {
  position: absolute; z-index: var(--z-popover); top: calc(100% + 8px); right: 0; display: grid; gap: 10px;
  width: min(420px, calc(100vw - 2 * var(--page-gutter))); padding: 14px 16px; border: 1px solid var(--color-border);
  border-radius: var(--radius-card); background: var(--card); box-shadow: var(--shadow-popover); animation: doctor-panel-in var(--motion-fast) ease-out;
}
.doctor-items { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; font-size: 13px; line-height: 1.5; }
.doctor-hint { display: block; color: var(--color-muted); }
.doctor-link { height: auto; padding: 0; }
.doctor-failure { margin: 0; color: var(--color-danger); font-size: 13px; }
.doctor-actions { display: flex; justify-content: flex-end; }
@keyframes doctor-panel-in { from { opacity: 0; transform: translateY(-4px); } }
@media (prefers-reduced-motion: reduce) { .doctor-panel { animation: none; } }
:root[data-motion="reduced"] .doctor-panel { animation: none; }
</style>
