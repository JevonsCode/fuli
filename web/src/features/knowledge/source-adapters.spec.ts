import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CONVERSATION_LAUNCHERS,
  copySourceSession,
  sessionLaunchKey,
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

  it('names Antigravity as its own client, apart from Gemini CLI, with no launcher', () => {
    const antigravity = { source_application: 'antigravity', session_id: 'antigravity-session-1' }
    expect(sourceApplicationLabel(antigravity)).toBe('Antigravity')
    expect(sourceApplicationLabel({ source_kind: 'Antigravity conversation via Gemini' })).toBe('Antigravity')
    expect(sessionLaunchKey(antigravity)).toBe('antigravity:antigravity-session-1')
    expect(sourceLauncherStatus(antigravity)).toBe('disabled')
    expect(sourceLinkForEvidence(antigravity)).toBeNull()
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

  it('follows the session launcher when it answered, and the template when it could not', () => {
    const codex = { source_application: 'codex', session_id: '123e4567-e89b-42d3-a456-426614174000' }
    const offer = (answer: 'link' | 'none' | 'fuli', href?: string) => ({
      sourceApplication: 'codex' as const, sessionId: codex.session_id, client: 'codex', offer: answer, href,
    })

    expect(sessionLaunchKey(codex)).toBe('codex:123e4567-e89b-42d3-a456-426614174000')
    expect(sessionLaunchKey({ source_kind: 'Cursor conversation', session_id: ' cursor-7 ' })).toBe('cursor:cursor-7')
    expect(sessionLaunchKey({ source_application: 'codex' })).toBeNull()
    expect(sourceLinkForEvidence(codex, DEFAULT_CONVERSATION_LAUNCHERS, offer('link', 'codex://threads/planned')))
      .toBe('codex://threads/planned')
    expect(sourceLinkForEvidence(codex, DEFAULT_CONVERSATION_LAUNCHERS, offer('none'))).toBeNull()
    expect(sourceLinkForEvidence(codex, DEFAULT_CONVERSATION_LAUNCHERS, offer('fuli')))
      .toBe('codex://threads/123e4567-e89b-42d3-a456-426614174000')
  })
})
