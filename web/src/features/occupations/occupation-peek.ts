import type { OccupationEntry } from './occupation-catalog'

// What the quick look at one occupation (?item=<space>/<key>) can show. The
// catalog read is the space's whole catalog, never a page of it, so a key is
// looked up by its exact identity there. "Missing" is said only after this
// space's catalog was read in full; a pending or failed read keeps the link
// open with loading or a retry instead.
export type OccupationPeekState =
  | { kind: 'ready'; entry: OccupationEntry }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'missing' }

export function occupationPeekState(input: {
  item: { spaceId: string; id: string }
  spaceId: string
  entries: readonly OccupationEntry[]
  loaded: boolean
  loading: boolean
  error: string
}): OccupationPeekState {
  if (!input.spaceId) return { kind: 'loading' }
  if (input.item.spaceId !== input.spaceId) return { kind: 'missing' }
  const entry = input.entries.find(candidate => candidate.key === input.item.id)
  if (entry) return { kind: 'ready', entry }
  if (input.loading) return { kind: 'loading' }
  if (input.error) return { kind: 'error', message: input.error }
  return input.loaded ? { kind: 'missing' } : { kind: 'loading' }
}
