import { expect, it, vi } from 'vitest'
import { subscribeChatUpdates, subscribeTaskUpdates } from './task-updates'

it('shares one task SSE for chat and tasks, filters events and refreshes after reconnect', () => {
  const sources: Source[] = []
  class Source extends EventTarget {
    close = vi.fn()
    constructor(public url: string) { super(); sources.push(this) }
  }
  vi.stubGlobal('EventSource', Source)
  const changed = vi.fn(), chat = vi.fn(), ready = vi.fn(), unavailable = vi.fn()
  const stopTask = subscribeTaskUpdates('space', { taskId: 'task', changed, unavailable })
  const stopChat = subscribeChatUpdates('space', { chatChanged: chat, reconnected: ready, unavailable })
  expect(sources).toHaveLength(1)
  sources[0]!.dispatchEvent(new MessageEvent('chat', { data: '{"chatId":"room","seq":3}' }))
  expect(chat).toHaveBeenCalledWith({ chatId: 'room', seq: 3 })
  expect(changed).not.toHaveBeenCalled()
  sources[0]!.dispatchEvent(new MessageEvent('message', { data: '{"taskId":"task"}' }))
  expect(changed).toHaveBeenCalledTimes(1)
  sources[0]!.dispatchEvent(new Event('ready'))
  expect(ready).toHaveBeenCalledTimes(1)
  stopChat(); expect(sources[0]!.close).not.toHaveBeenCalled()
  stopTask(); expect(sources[0]!.close).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})
