import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { roundtableApi, type RoundtableRoom, type RoundtableSnapshot } from './roundtable-api'
import { copy } from './copy'

export function useRoundtables(roomId: Ref<string>) {
  const rooms = ref<RoundtableRoom[]>([])
  const snapshot = ref<RoundtableSnapshot | null>(null)
  const loading = ref(false)
  const error = ref('')
  const loaded = ref(false)
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    if (loading.value || disposed) return
    const ownGeneration = generation
    const id = roomId.value
    loading.value = true
    try {
      const cursor = snapshot.value?.messages.at(-1)?.seq ?? 0
      const result = id ? await roundtableApi.read(id, cursor) : await roundtableApi.list()
      if (disposed || ownGeneration !== generation) return
      if ('room' in result) {
        const ordered = new Map([...(snapshot.value?.messages ?? []), ...result.messages].map(message => [message.id, message]))
        snapshot.value = { ...result, messages: [...ordered.values()].sort((a, b) => a.seq - b.seq) }
      }
      else rooms.value = result.rooms
      loaded.value = true
      error.value = ''
    } catch (reason) {
      if (!disposed && ownGeneration === generation) error.value = reason instanceof Error ? reason.message : copy('读取圆桌失败', 'Could not read roundtable')
    } finally { if (ownGeneration === generation) loading.value = false }
  }
  function schedule() {
    if (disposed) return
    timer = setTimeout(async () => { await refresh(); schedule() }, 4000)
  }
  watch(roomId, async () => {
    generation++; loading.value = false; snapshot.value = null; error.value = ''; loaded.value = false
    const ownGeneration = generation
    if (timer) clearTimeout(timer)
    await refresh(); if (ownGeneration === generation) schedule()
  }, { immediate: true })
  onBeforeUnmount(() => { disposed = true; generation++; if (timer) clearTimeout(timer) })
  return { rooms, snapshot, loading, loaded, error, refresh }
}
