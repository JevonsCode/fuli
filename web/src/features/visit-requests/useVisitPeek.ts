import { computed } from 'vue'
import { peekItemValue, useRoutePeek } from '@/composables/useRoutePeek'

// A request's card opens as a quick look, ?item=visit/<id>: requests belong to
// this computer, not to a knowledge space, so they share one fixed first part.
const VISIT_PEEK = 'visit'
export const VISIT_REQUESTS_PATH = '/visit-requests'

/** The list of every request with this one's card open: where a toast about it links. */
export function visitRequestLocation(id: string) {
  return `${VISIT_REQUESTS_PATH}?item=${peekItemValue({ spaceId: VISIT_PEEK, id })}`
}

export function useVisitPeek() {
  const peek = useRoutePeek()
  const id = computed(() => (peek.item.value?.spaceId === VISIT_PEEK ? peek.item.value.id : ''))
  return { id, open: (requestId: string) => peek.open({ spaceId: VISIT_PEEK, id: requestId }), close: peek.close }
}
