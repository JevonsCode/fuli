import { reactive, shallowReadonly } from 'vue'
import { ApiError } from '@/api/client'
import { readVisitRequests } from './visit-request-api'
import type { VisitRequest } from './visit-request-shape'

// What 等你拍板 shows of other computers' requests: the newest waiting for the
// person's call with their count, and every finished run waiting for a look.
// One read shared by 今天 and every decision, so a click anywhere updates the row.
const REVIEWS_READ = 50

const state = reactive({
  status: 'loading' as 'loading' | 'ready' | 'failed',
  count: 0,
  newest: [] as VisitRequest[],
  reviews: [] as VisitRequest[],
})

async function load() {
  try {
    const answer = await readVisitRequests({ state: 'awaiting_review', limit: REVIEWS_READ })
    Object.assign(state, { status: 'ready', count: answer.awaiting.count, newest: answer.awaiting.newest, reviews: answer.requests })
  } catch (error) {
    // Without a local installation (503) or away from this computer (403) nothing here can wait for a call.
    if (error instanceof ApiError && (error.status === 503 || error.status === 403)) {
      Object.assign(state, { status: 'ready', count: 0, newest: [], reviews: [] })
    } else if (state.status === 'loading') state.status = 'failed'
  }
}

export function useVisitAwaiting() {
  return { state: shallowReadonly(state), load }
}
