import { onBeforeUnmount, ref } from 'vue'

// One shared clock for elapsed-time labels, running only while used.
const now = ref(Date.now())
let users = 0
let timer: ReturnType<typeof setInterval> | undefined

export function useNow(intervalMs = 60_000) {
  users += 1
  if (!timer) {
    now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now() }, intervalMs)
  }
  onBeforeUnmount(() => {
    users -= 1
    if (!users && timer) {
      clearInterval(timer)
      timer = undefined
    }
  })
  return now
}
