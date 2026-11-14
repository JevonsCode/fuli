import { afterEach, expect, it, vi } from 'vitest'

import { useVisitAwaiting } from './useVisitAwaiting'

const answer = (count: number) => new Response(JSON.stringify({ requests: [], awaiting: { count, newest: [] } }),
  { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals() })

it('keeps the newest read when an older one answers after it', async () => {
  const pending: Array<(response: Response) => void> = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve) })))
  const awaiting = useVisitAwaiting()
  const older = awaiting.load()
  const newer = awaiting.load()
  pending[1]!(answer(2))
  await newer
  expect(awaiting.state.count).toBe(2)
  pending[0]!(answer(5))
  await older
  expect(awaiting.state.count).toBe(2)
})
