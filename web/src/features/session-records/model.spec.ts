import { describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import {
  entryTypeLabel, peekEntry, sessionRecordsPath, sourceSessionPath, stretchLabel, transcriptRows,
  type SessionEntry, type SessionRecordsView,
} from './model'

const local = (hour: number, minute: number) => new Date(2026, 9, 20, hour, minute).toISOString()

function entry(number: number, key: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { number, key, group: 'transcript', kind: 'turn', type: '会话原文', summary: `Synthetic ${number}`,
    at: local(10, number), project: { id: 'thesis', name: '毕业论文' }, link: '', detail: {}, ...overrides }
}

function view(): SessionRecordsView {
  return { session: { sourceApplication: 'codex', sessionId: 's-1', url: '' }, total: 3, truncated: false,
    entries: [entry(1, 'turn:t1'), entry(2, 'turn:t2', { at: local(15, 10) }),
      entry(3, 'entity:cite', { group: 'preference_evidence', kind: 'entity', turn: 'turn:t1',
        detail: { sources: [{ episode_id: 'e-1', turn: 'turn:t1' }] } }),
      entry(4, 'entity:orphan', { group: 'knowledge', kind: 'entity', detail: { sources: [{ episode_id: 'e-2', turn: null }] } })],
    stretches: [{ from: local(14, 32), to: local(15, 10), paused: true, reasons: [] }] }
}

describe('session records model', () => {
  it('puts a paused stretch between the turns it separates and labels it HH:mm～HH:mm 暂停记录 (C6-4)', () => {
    setLocale('zh-CN')
    const rows = transcriptRows(view())
    expect(rows.map(row => row.kind === 'entry' ? row.entry.key : 'stretch')).toEqual(['turn:t1', 'stretch', 'turn:t2'])
    const stretch = rows[1]
    expect(stretch.kind === 'stretch' && stretchLabel(stretch.stretch)).toBe('14:32～15:10 暂停记录')
    expect(stretchLabel({ from: local(9, 5), to: local(9, 20), paused: false, reasons: ['project_off'] })).toBe('09:05～09:20 未记录')
  })

  it('a knowledge source opens the turn that wrote it, or the item when that turn saved no words (C6-3)', () => {
    expect(peekEntry(view(), 'episode:e-1')?.key).toBe('turn:t1')
    expect(peekEntry(view(), 'episode:e-2')?.key).toBe('entity:orphan')
    expect(peekEntry(view(), 'entity:cite')?.number).toBe(3)
    expect(peekEntry(view(), 'turn:missing')).toBeNull()
    expect(peekEntry(null, 'turn:t1')).toBeNull()
  })

  it('every source of an item opens its own turn, not only the first (dot #263 P2-2)', () => {
    const records = view()
    records.entries[2].detail.sources = [{ episode_id: 'e-1', turn: 'turn:t1' }, { episode_id: 'e-3', turn: 'turn:t2' }]
    expect(peekEntry(records, 'episode:e-1')?.key).toBe('turn:t1')
    expect(peekEntry(records, 'episode:e-3')?.key).toBe('turn:t2')
  })

  it('links name the session and the record, and a source without a session links nowhere', () => {
    expect(sessionRecordsPath('s 1')).toBe('/s/s%201')
    expect(sessionRecordsPath('s 1', { client: 'codex' })).toBe('/s/s%201?client=codex')
    expect(sessionRecordsPath('s-1', { spaceId: 'space/1', key: 'turn:t1' })).toBe('/s/s-1?item=space%2F1/turn%3At1')
    expect(sourceSessionPath('space', { session_id: 's-1', source_application: 'codex', episode_id: 'e-1' }))
      .toBe('/s/s-1?client=codex&item=space/episode%3Ae-1')
    expect(sourceSessionPath('space', { session_id: null, source_application: 'codex', episode_id: 'e-1' })).toBe('')
  })

  it('names each type in the page language', () => {
    setLocale('en-US')
    expect(entryTypeLabel(entry(1, 'turn:t1'))).toBe('Saved words')
    expect(entryTypeLabel(entry(4, 'entity:x', { group: 'knowledge', kind: 'entity', detail: { item: {
      change: 'updated', category: 'fact' } as never } }))).toBe('Updated Fact')
    setLocale('zh-CN')
    expect(entryTypeLabel(entry(4, 'entity:x', { group: 'knowledge', kind: 'entity', detail: { item: {
      change: 'created', category: 'fact' } as never } }))).toBe('新增 事实')
    expect(entryTypeLabel(entry(3, 'entity:cite', { group: 'preference_evidence' }))).toBe('偏好证据')
  })
})
