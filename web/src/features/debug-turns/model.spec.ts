import { describe, expect, it } from 'vitest'
import { fuliShare, partTitle, sourceColour, startsFolded, type DebugPart } from './model'
import semantic from '@/styles/theme/semantic.css?raw'

// Synthetic parts only.
const part = (fields: Partial<DebugPart>): DebugPart => ({ source: 'fuli', kind: 'hook_frame', label: '', text: '{}', bytes: 2, ...fields })

describe('debug turn record model', () => {
  it('says how many bytes FULI added and their whole-percent share of the turn', () => {
    expect(fuliShare({ person: 100, fuli: 300, ai: 400, host: 200, not_visible: 0 })).toEqual({ bytes: 300, total: 1000, percent: 30 })
    expect(fuliShare({ person: 1, fuli: 2, ai: 0, host: 0, not_visible: 0 }).percent).toBe(67)
    expect(fuliShare({ person: 0, fuli: 0, ai: 0, host: 0, not_visible: 0 })).toEqual({ bytes: 0, total: 0, percent: 0 })
  })

  it('names each part by its kind, with a count for the tool list and the history', () => {
    expect(partTitle(part({ kind: 'mcp_tools', label: '6' }))).toBe('FULI 工具列表 · 6 个工具')
    expect(partTitle(part({ source: 'host', kind: 'history', label: '12' }))).toBe('之前的对话 · 12 条消息')
    expect(partTitle(part({ kind: 'hook_frame', label: 'Stop' }))).toBe('FULI 钩子 · Stop')
    expect(partTitle(part({ kind: 'tool_call', label: 'mcp__fuli__remember' }))).toBe('工具调用 · mcp__fuli__remember')
    expect(partTitle(part({ source: 'person', kind: 'prompt' }))).toBe('你的提问')
    expect(partTitle(part({ source: 'host', kind: 'synthetic_kind' }))).toBe('synthetic_kind')
  })

  it('colours every source from its own semantic token', () => {
    for (const source of ['person', 'fuli', 'ai', 'host', 'not_visible'] as const) {
      const token = sourceColour(source).match(/^var\((--[\w-]+)\)$/)?.[1]
      expect(token && semantic.includes(`${token}:`), source).toBe(true)
    }
    expect(new Set(['person', 'fuli', 'ai', 'host', 'not_visible'].map(s => sourceColour(s as DebugPart['source']))).size).toBe(5)
  })

  it('folds a long part and leaves a short one open', () => {
    expect(startsFolded(part({ text: 'x', bytes: 1 }))).toBe(false)
    expect(startsFolded(part({ text: 'x'.repeat(700), bytes: 700 }))).toBe(true)
    expect(startsFolded(part({ text: 'a\n'.repeat(20), bytes: 40 }))).toBe(true)
  })
})
