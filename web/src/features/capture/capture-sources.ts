import { coversClient } from '@/lib/source-coverage'
import type { CapturePolicy } from '@/types'

type CaptureSources = Pick<CapturePolicy, 'disabledSources' | 'capturedSources'>

export function captureSourceOff(policy: CaptureSources, source: string) {
  return coversClient(policy.disabledSources, source, { explicit: policy.capturedSources })
}

// An explicit on overrides a legacy alias without enabling its other clients.
// An explicit off removes that override and names the client in disabledSources.
export function withCaptureSource(policy: CaptureSources, source: string, capture: boolean) {
  const disabled = (policy.disabledSources ?? []).filter(value => value !== source)
  const captured = (policy.capturedSources ?? []).filter(value => value !== source)
  return {
    disabledSources: capture ? disabled : [...disabled, source],
    capturedSources: capture ? [...captured, source] : captured,
  }
}
