import { computed, type Ref } from 'vue'
import { readAgentSheets } from '@/features/team-work/team-sheets'
import { sharedRead } from '@/lib/shared-read'

// One read of an FLA's task sheets, shared by the 现在 line (the step and the
// bar of the task it is on) and 手上的活 (every open sheet).
const sheets = sharedRead((key, signal) => readAgentSheets(key[0]!, key[1]!, signal))

export function useAgentSheets(spaceId: Ref<string>, agentId: Ref<string>) {
  const read = sheets.use(computed(() => [spaceId.value, agentId.value]))
  return {
    sheets: computed(() => read.value.value?.workbenches ?? []),
    partial: computed(() => read.value.value?.partial ?? false),
    state: read.state,
    /** A server older than the sheets route answers 404: nothing to show, not a failure to retry. */
    unsupported: computed(() => (read.error.value as { status?: unknown } | null)?.status === 404),
    reload: read.reload,
  }
}
