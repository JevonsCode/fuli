import { describe, expect, it } from 'vitest'

// Every API answer should be checked where it arrives (api/response-shape.ts):
// `getJson(url, shape)` instead of `getJson<T>(url)`, which only casts. This
// count of unchecked casts may only go down: lower it in the same change that
// gives a read its shape. 2026-11-01: 202 after the console state, Agent
// records, team sheets, Agent looks and the employee catalog got theirs.
const UNCHECKED_BASELINE = 202
const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.vue', '!../**/*.spec.ts', '!./client.ts'], { query: '?raw', import: 'default', eager: true })
const UNCHECKED_CAST = /\b(?:get|post|put|patch|delete)Json</g

describe('API response validation', () => {
  it('never adds an unchecked response cast', () => {
    const files = Object.entries(sources)
    expect(files.length).toBeGreaterThan(100)
    const unchecked = files.reduce((sum, [, source]) => sum + (source.match(UNCHECKED_CAST)?.length ?? 0), 0)
    expect(unchecked, 'give the read a ResponseShape (api/response-shape.ts) instead of a type argument').toBeLessThanOrEqual(UNCHECKED_BASELINE)
  })
})
