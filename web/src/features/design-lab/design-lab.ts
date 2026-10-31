import { ref, watch } from 'vue'

const STORAGE_KEY = 'fuli.lab'

function readWorkbench(): string {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    return typeof stored?.workbench === 'string' ? stored.workbench : 'current'
  } catch {
    return 'current'
  }
}

export const designLab = ref({ workbench: typeof window === 'undefined' ? 'current' : readWorkbench() })

watch(designLab, state => {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ workbench: state.workbench })) } catch { /* storage may be unavailable */ }
}, { deep: true, immediate: true })
