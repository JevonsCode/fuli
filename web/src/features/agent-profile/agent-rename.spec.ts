import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { nameTaken } from './agent-rename'

// A refused name as the console API sends it (src/http/error-mapping.js): the
// fields are read as they are, never parsed out of the sentence.
const refusal = (body: object) => new ApiError('409', 409, JSON.stringify(body))

describe('nameTaken', () => {
  it('reads who uses the name, where, and the free names from the fields', () => {
    expect(nameTaken(refusal({ error: 'agent_name_taken — …', code: 'agent_name_taken',
      usedBy: [{ agentId: 'agent-x', name: 'Morgan Vale', projects: ['Saturn', 'Station Backup'] },
        { agentId: 'employee.tonborg', name: 'Tonborg', projects: [] }],
      freeNames: ['Nora Lin', 'Theo Hart', '林夏'] }))).toEqual({
      usedBy: [{ name: 'Morgan Vale', projects: ['Saturn', 'Station Backup'] }, { name: 'Tonborg', projects: [] }],
      freeNames: ['Nora Lin', 'Theo Hart', '林夏'] })
  })

  it('is null for any other failure', () => {
    expect(nameTaken(refusal({ error: 'agent_profile_changed: try again', code: 'provider_error' }))).toBeNull()
    expect(nameTaken(new Error('offline'))).toBeNull()
  })
})
