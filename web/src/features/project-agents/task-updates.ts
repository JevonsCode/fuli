type TaskListener = { taskId: string; changed: () => void; unavailable: () => void }
export type ChatUpdate = { chatId: string; seq: number }
type ChatListener = { chatChanged: (event: ChatUpdate) => void; reconnected: () => void; unavailable: () => void }
type Listener = TaskListener | ChatListener
const ready = (item: Listener) => 'taskId' in item ? item.changed() : item.reconnected()
const connections = new Map<string, { source: EventSource; listeners: Set<Listener>; ready: boolean }>()

export function subscribeTaskUpdates(spaceId: string, listener: TaskListener) { return subscribe(spaceId, listener) }
export function subscribeChatUpdates(spaceId: string, listener: ChatListener) { return subscribe(spaceId, listener) }

function subscribe(spaceId: string, listener: Listener) {
  let connection = connections.get(spaceId)
  if (!connection) {
    const source = new EventSource(`/api/project-agent-task-events?${new URLSearchParams({ personalSpaceId: spaceId })}`)
    const current = { source, listeners: new Set<Listener>(), ready: false }
    source.addEventListener('ready', () => {
      current.ready = true
      current.listeners.forEach(ready)
    })
    source.addEventListener('message', event => {
      const { taskId } = JSON.parse((event as MessageEvent<string>).data) as { taskId: string | null }
      current.listeners.forEach(item => { if ('taskId' in item && (taskId === null || taskId === item.taskId)) item.changed() })
    })
    source.addEventListener('chat', event => {
      const update = JSON.parse((event as MessageEvent<string>).data) as ChatUpdate
      current.listeners.forEach(item => { if ('chatChanged' in item) item.chatChanged(update) })
    })
    source.addEventListener('chat-unavailable', () => {
      current.listeners.forEach(item => { if ('chatChanged' in item) item.unavailable() })
    })
    source.addEventListener('chat-ready', () => {
      current.listeners.forEach(item => { if ('chatChanged' in item) item.reconnected() })
    })
    source.addEventListener('error', () => {
      current.ready = false
      current.listeners.forEach(item => item.unavailable())
    })
    connections.set(spaceId, current)
    connection = current
  }
  const current = connection
  current.listeners.add(listener)
  if (current.ready) queueMicrotask(() => { if (current.listeners.has(listener)) ready(listener) })
  return () => {
    current.listeners.delete(listener)
    if (!current.listeners.size) {
      current.source.close()
      connections.delete(spaceId)
    }
  }
}
