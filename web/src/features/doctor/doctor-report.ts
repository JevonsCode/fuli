import { computed, ref } from 'vue'

import { readDoctor, type DoctorReport } from './model'

// The doctor's last answer, shared by everything in the shell that shows part
// of it: the top bar's chip (DoctorBanner polls it) and the dot on 设置 when a
// client's FULI integration needs an update. A failed read keeps the last answer.
export const doctorReport = ref<DoctorReport | null>(null)

let reading: Promise<void> | null = null
let again = false

// One read at a time. A read asked for while one is in flight runs once that
// one ends, so a change made meanwhile (a client just updated) is not missed.
export function refreshDoctorReport(): Promise<void> {
  if (reading) {
    again = true
    return reading
  }
  reading = (async () => {
    do {
      again = false
      try { doctorReport.value = await readDoctor() } catch { /* keep the last answer; the next read tries again */ }
    } while (again)
  })().finally(() => { reading = null })
  return reading
}

// A client FULI was in whose integration is older or partial (status changed or
// skills_left): 设置 › 客户端 offers 「更新」 or 「重新接入」 for it.
export const clientsNeedUpdate = computed(() => doctorReport.value?.items.some(item => item.kind === 'client_outdated') ?? false)
