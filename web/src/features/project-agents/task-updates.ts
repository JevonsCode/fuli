type Listener = { taskId: string; changed: () => void; unavailable: () => void }
const connections = new Map<string, { source: EventSource; listeners: Set<Listener>; ready: boolean }>()

export function subscribeTaskUpdates(spaceId: string, listener: Listener) {
  let connection = connections.get(spaceId)
  if (!connection) {
    const source = new EventSource(`/api/project-agent-task-events?${new URLSearchParams({ personalSpaceId: spaceId })}`)
    const current = { source, listeners: new Set<Listener>(), ready: false }
    source.addEventListener('ready', () => {
      current.ready = true
      current.listeners.forEach(item => item.changed())
    })
    source.addEventListener('message', event => {
      const { taskId } = JSON.parse((event as MessageEvent<string>).data) as { taskId: string | null }
      current.listeners.forEach(item => { if (taskId === null || taskId === item.taskId) item.changed() })
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
  if (current.ready) queueMicrotask(() => { if (current.listeners.has(listener)) listener.changed() })
  return () => {
    current.listeners.delete(listener)
    if (!current.listeners.size) {
      current.source.close()
      connections.delete(spaceId)
    }
  }
}
