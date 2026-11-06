import { computed, ref } from 'vue'

// A page tool's change the delegation gate does not let an Agent make alone
// (a key, the endpoint listing, a decision that is the person's own) waits
// for the person's own click on this page. One question at a time; the rest
// wait in order. What the sheet shows never contains a secret.

export interface ConfirmationText {
  /** What will happen, naming its object: 「保存密钥 openai-work」. */
  title: string
  /** At most a few short lines: where it goes, what it changes. */
  lines: string[]
}

interface Pending extends ConfirmationText {
  id: number
  tool: string
  settle: (allowed: boolean) => void
}

const queue = ref<Pending[]>([])
let nextId = 0

function settle(id: number, allowed: boolean) {
  const entry = queue.value.find(candidate => candidate.id === id)
  if (!entry) return
  queue.value = queue.value.filter(candidate => candidate.id !== id)
  entry.settle(allowed)
}

/** Resolves true only after the person allows it; an aborted call counts as no. */
export function askPerson(tool: string, text: ConfirmationText, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const id = ++nextId
    queue.value = [...queue.value, { ...text, id, tool, settle: resolve }]
    signal?.addEventListener('abort', () => settle(id, false), { once: true })
  })
}

export function usePersonConfirmation() {
  return {
    current: computed(() => queue.value[0] ?? null),
    waiting: computed(() => Math.max(queue.value.length - 1, 0)),
    answer: settle,
  }
}
