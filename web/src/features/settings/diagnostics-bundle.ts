import { getJson } from '@/api/client'
import { t } from '@/i18n'
import { tableLabel } from '@/i18n/label-table'

// The 诊断包 (src/system/diagnostics-bundle.js): what the person previews
// and then exports for FULI's developers. Every file is already redacted.
export interface DiagnosticsFile { name: string; content: string }
export interface DiagnosticsBundle { generatedAt: string; files: DiagnosticsFile[]; redactions: Record<string, number> }

export const readDiagnosticsBundle = (personalSpaceId: string) =>
  getJson<DiagnosticsBundle>(`/api/system/diagnostics?personalSpaceId=${encodeURIComponent(personalSpaceId)}`)

/** What was hidden, one line per kind found, most first; an unknown kind keeps its code. */
export function redactionSummary(redactions: Record<string, number>): string[] {
  return Object.entries(redactions)
    .filter(([, count]) => count > 0)
    .sort(([, left], [, right]) => right - left)
    .map(([kind, count]) => t('settings.diagnostics.redactionCount',
      { kind: tableLabel('settings.diagnostics.kinds', kind) ?? kind, count }))
}

/** The exported file: the bundle as the person previewed it, named by when it was made. */
export function diagnosticsExport(bundle: DiagnosticsBundle): { name: string; content: string } {
  const stamp = bundle.generatedAt.replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-')
  return { name: `fuli-diagnostics-${stamp}.json`, content: `${JSON.stringify(bundle, null, 2)}\n` }
}
