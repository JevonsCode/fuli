import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CONVERSATION_LAUNCHERS,
  copySourceSession,
  sourceApplicationLabel,
  sourceLinkForEvidence,
  sourceLauncherStatus,
} from './source-adapters'

describe('knowledge source adapters', () => {
  it('opens only native Codex UUIDs through the safe default template', () => {
    expect(sourceLinkForEvidence({
      source_application: 'codex',
      session_id: '123e4567-e89b-42d3-a456-426614174000',
    })).toBe('codex://threads/123e4567-e89b-42d3-a456-426614174000')
    expect(sourceLinkForEvidence({
      source_application: 'codex',
      session_id: 'codex-fuli-ui-status-dedup-20260723',
    })).toBeNull()
    expect(sourceLauncherStatus({
      source_application: 'codex',
      session_id: 'codex-fuli-ui-status-dedup-20260723',
    })).toBe('invalid_id')
  })

  it('uses the configured app template and ID format for another Agent', () => {
    const configuration = structuredClone(DEFAULT_CONVERSATION_LAUNCHERS)
    configuration.cursor = {
      enabled: true,
      idFormat: 'uuid',
      appName: 'Cursor',
      urlTemplate: 'cursor://conversation/{id}',
    }

    expect(sourceApplicationLabel({ source_kind: 'Cursor conversation' })).toBe('Cursor')
    expect(sourceLinkForEvidence({
      source_kind: 'Cursor conversation',
      session_id: 'cursor-session-7',
    }, configuration)).toBeNull()
    expect(sourceLinkForEvidence({
      source_kind: 'Cursor conversation',
      session_id: '123e4567-e89b-42d3-a456-426614174000',
    }, configuration)).toBe('cursor://conversation/123e4567-e89b-42d3-a456-426614174000')
  })

  it('keeps copying available independently from opening', async () => {
    const cursor = { source_kind: 'Cursor conversation', session_id: 'cursor-session-7' }
    const writeText = vi.fn().mockResolvedValue(undefined)

    await expect(copySourceSession(cursor, { writeText })).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('cursor-session-7')
  })

  it('does not invent a link or copy action without a valid source identity', async () => {
    const writeText = vi.fn()

    expect(sourceLinkForEvidence({
      source_application: 'cursor',
      session_id: 'not-a-thread-id',
    })).toBeNull()
    await expect(copySourceSession({}, { writeText })).resolves.toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })
})
