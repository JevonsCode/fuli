import { describe, expect, it } from 'vitest'
import { roundtableMessages } from '@/i18n/messages/roundtable'

// A key a roundtable component names but no language defines is shown raw
// (the title bar read "roundtable.details"). Every literal key must exist.
const sources = import.meta.glob<string>(['./**/*.vue', './**/*.ts', '!./**/*.spec.ts'], { query: '?raw', import: 'default', eager: true })
// Whole literal keys only; a prefix completed at run time ('roundtable.chat.kinds.' + kind) is not one.
const KEY = /\bt\(\s*['"]roundtable\.([A-Za-z0-9_.]*[A-Za-z0-9_])['"]\s*[,)]/g

function defined(tree: unknown, path: string) {
  let node = tree
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

describe('roundtable message keys', () => {
  it('defines every key the roundtable components name, in both languages', () => {
    const keys = [...new Set(Object.values(sources).flatMap(source => [...source.matchAll(KEY)].map(match => match[1]!)))]
    expect(keys.length).toBeGreaterThan(20)
    const missing = Object.entries(roundtableMessages).flatMap(([language, tree]) =>
      keys.filter(key => !defined(tree, key)).map(key => `${language}: roundtable.${key}`))
    expect(missing).toEqual([])
  })
})
