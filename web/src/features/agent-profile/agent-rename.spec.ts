import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { freeNamesOffered } from './agent-rename'

// The refusal as the Provider words it (graph-provider/fuli_graph/store_project_agent_naming.py
// _name_taken), passed through the console as { error, code }. If that wording changes,
// this spec fails rather than the free names silently disappearing.
const refusal = (text: string) => new ApiError('409', 409, JSON.stringify({ error: text, code: 'provider_error' }))
const PROVIDER_TEXT = 'agent_name_taken: another Agent in this personal space already uses this name; '
  + 'free names: Nora Lin, Theo Hart, 林夏. Choose one or propose another.'

describe('freeNamesOffered', () => {
  it('reads the free names from the Provider’s refusal', () => {
    expect(freeNamesOffered(refusal(PROVIDER_TEXT))).toEqual(['Nora Lin', 'Theo Hart', '林夏'])
  })

  it('is an empty offer when the refusal lists none, and null for any other failure', () => {
    expect(freeNamesOffered(refusal('agent_name_taken: another Agent already uses this name.'))).toEqual([])
    expect(freeNamesOffered(refusal('agent_profile_changed: try again'))).toBeNull()
    expect(freeNamesOffered(new Error('offline'))).toBeNull()
  })
})
