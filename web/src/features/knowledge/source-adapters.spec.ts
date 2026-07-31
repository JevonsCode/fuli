import { describe, expect, it, vi } from 'vitest'

import {
  copySourceSession,
  sourceApplicationLabel,
  sourceLinkForEvidence,
} from './source-adapters'

describe('knowledge source adapters', () => {
  it('opens an exact Codex task and uses a copy fallback for other agents', async () => {
    const codex = {
      source_application: 'codex',
      session_id: '123e4567-e89b-42d3-a456-426614174000',
    }
    const cursor = {
      source_kind: 'Cursor conversation',
      session_id: 'cursor-session-7',
    }
    const writeText = vi.fn().mockResolvedValue(undefined)

    expect(sourceLinkForEvidence(codex))
      .toBe('codex://threads/123e4567-e89b-42d3-a456-426614174000')
    expect(sourceApplicationLabel(cursor)).toBe('Cursor')
    expect(sourceLinkForEvidence(cursor)).toBeNull()
    await expect(copySourceSession(cursor, { writeText })).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('cursor-session-7')
  })

  it('does not invent a link or copy action without a valid source identity', async () => {
    const writeText = vi.fn()

    expect(sourceLinkForEvidence({
      source_application: 'codex',
      session_id: 'not-a-thread-id',
    })).toBeNull()
    await expect(copySourceSession({}, { writeText })).resolves.toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })
})
