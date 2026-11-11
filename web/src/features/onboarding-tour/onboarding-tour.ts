import { reactive } from 'vue'

import { knowledgePath, personalProjectsPath } from '@/router/paths'
import type { ConsoleState } from '@/types'
import type { IconName } from '@/ui'

// The beginner's guide (新手引导, Jevons 11-12): six short steps on how FULI is
// used. Every installation, new or from before, sees each TOUR_VERSION once;
// the server keeps the newest version shown (firstRunGuide.tourSeen in
// /api/state, src/graphiti/first-run-guide.js), so the browser and the
// desktop client agree. Raise TOUR_VERSION when the steps change enough that
// people who saw the old ones should see them again.
export const TOUR_VERSION = 1

export type TourStepId = 'what' | 'clients' | 'reply' | 'memory' | 'projects' | 'roundtable'
// brand: the FULI mark; otherwise the icon of the place the step is about.
interface TourStep { id: TourStepId; icon: IconName | 'brand' }

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'what', icon: 'brand' },
  { id: 'clients', icon: 'openInApp' },
  { id: 'reply', icon: 'agents' },
  { id: 'memory', icon: 'memory' },
  { id: 'projects', icon: 'project' },
  { id: 'roundtable', icon: 'roundtable' },
]

// open: the dialog is on screen. paused: the person followed a step's 「去…」
// and can continue from that step. offered: this console open already chose
// whether to show it on its own; deciding: it is still waiting to choose (the
// state is loading or the first-run dialog is open). While it decides or is
// open, the corner's what's-new notice waits behind it.
export const tour = reactive({ open: false, paused: false, step: 0, offered: false, deciding: false })

/** The guide from step 1: on its own once per version, or from 设置 › 系统 › 界面 「再看一遍」. */
export function startTour() {
  Object.assign(tour, { open: true, paused: false, step: 0 })
}

/** Went to a step's place: the dialog closes and the corner offers to continue at that step. */
export function pauseTour() {
  Object.assign(tour, { open: false, paused: true })
}

export function resumeTour() {
  Object.assign(tour, { open: true, paused: false })
}

export function endTour() {
  Object.assign(tour, { open: false, paused: false })
}

export const tourHoldsNotices = () => tour.open || tour.deciding

/** Whether this console open should show the guide on its own: a version the server has not recorded as shown. */
export const tourDue = (state: ConsoleState) => (state.firstRunGuide?.tourSeen ?? 0) < TOUR_VERSION

/** Where a step's one action goes, or null for a step that is not about a place. */
export function stepTarget(id: TourStepId, spaceId: string): string | null {
  switch (id) {
    case 'clients': return '/settings?tab=clients'
    case 'reply': return '/project-agents'
    case 'memory': return knowledgePath('personal', spaceId, 'directory')
    case 'projects': return personalProjectsPath(spaceId, 'graph')
    case 'roundtable': return '/roundtables'
    default: return null
  }
}
