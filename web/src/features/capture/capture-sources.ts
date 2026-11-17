import { coversClient } from '@/lib/source-coverage'
import type { CapturePolicy } from '@/types'

type CaptureSources = Pick<CapturePolicy, 'disabledSources' | 'capturedSources'>

export function captureSourceOff(policy: CaptureSources, source: string) {
  return coversClient(policy.disabledSources, source, { explicit: policy.capturedSources })
}

// The clients a stored `other` also covers (rec#11 D-64, lib/source-coverage.ts).
const OTHER_ALIASES = ['opencode', 'antigravity', 'dsh']

// An explicit on overrides a legacy alias without enabling its other clients.
// An explicit off removes that override and names the client in disabledSources.
// Turning `other` off keeps on the clients it used to stand for that are on now,
// so its own switch never turns OpenCode, Antigravity or DeepSeek Harness off.
export function withCaptureSource(policy: CaptureSources, source: string, capture: boolean) {
  const disabled = (policy.disabledSources ?? []).filter(value => value !== source)
  const captured = (policy.capturedSources ?? []).filter(value => value !== source)
  const keptOn = source === 'other' && !capture
    ? OTHER_ALIASES.filter(alias => !captured.includes(alias) && !captureSourceOff(policy, alias)) : []
  return {
    disabledSources: capture ? disabled : [...disabled, source],
    capturedSources: capture ? [...captured, source] : [...captured, ...keptOn],
  }
}
