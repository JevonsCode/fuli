// Knowledge and preferences show a weight instead of confirmed/pending. Ranges
// (decided by the user 2026-10-18): pending 10-69% rising with use and
// evidence; Agent-confirmed 70-95%; confirmed by a person or an authoritative
// source 100% with a "you confirmed" mark.
export type WeightBand = 'pending' | 'agent' | 'person'

export function weightBand(percent: number, confirmedByPerson = false): WeightBand {
  if (confirmedByPerson || percent >= 100) return 'person'
  return percent >= 70 ? 'agent' : 'pending'
}

export function clampWeight(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}
