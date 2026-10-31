import { describe, expect, it } from 'vitest'
import { chatRunMarks } from './chat-runs'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 8, minutes)).toISOString()

describe('chat runs', () => {
  it('starts with a time and groups a sender’s quick messages under one name', () => {
    expect(chatRunMarks([
      { from: 'a', at: at(0) },
      { from: 'a', at: at(1) },
      { from: 'b', at: at(2) },
      { from: 'b', at: at(10) },
    ])).toEqual([
      { separator: true, runStart: true },
      { separator: false, runStart: false },
      { separator: false, runStart: true },
      { separator: false, runStart: true },
    ])
  })

  it('puts a time between messages half an hour apart, even from the same sender', () => {
    expect(chatRunMarks([{ from: 'a', at: at(0) }, { from: 'a', at: at(40) }])[1]).toEqual({ separator: true, runStart: true })
  })

  it('treats an unreadable time as a break, never as a continuation', () => {
    expect(chatRunMarks([{ from: 'a', at: at(0) }, { from: 'a', at: 'not a time' }])[1]).toEqual({ separator: true, runStart: true })
  })
})
