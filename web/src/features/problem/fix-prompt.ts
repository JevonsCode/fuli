import { t } from '@/i18n'

// The prompt the person copies for their own AI when something in FULI does
// not work: what happened, where, the error, then how to go about it (look
// for a known issue first, fix what is easy, ask before opening an issue).
// Nothing personal leaves in it: home paths, emails, URL queries and long
// secrets are hidden before it reaches the clipboard.

export const ISSUES_URL = 'https://github.com/JevonsCode/fuli/issues'

export interface ProblemFacts {
  /** What the person saw, in words. */
  what: string
  /** The error message, if there was one. */
  error?: string | null
  /** The console path it happened on. */
  page: string
  version?: string | null
  serviceReady?: boolean | null
}

const HIDDEN = '…'
const RULES: [RegExp, string][] = [
  // Windows and Unix home directories, in either slash direction.
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/gi, `~`],
  [/\/(?:Users|home)\/[^/\s"'<>]+/g, `~`],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, HIDDEN],
  [/(\bhttps?:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi, `$1`],
  [/(?<![A-Za-z0-9_+=-])(?:[A-Fa-f0-9]{32,}|(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+-]{40,}={0,2})(?![A-Za-z0-9_+=-])/g, HIDDEN],
]

/** The text with home paths, emails, URL queries and long secrets hidden. */
export function redactForPrompt(text: string): string {
  return RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
}

export function fixPrompt(facts: ProblemFacts): string {
  const line = (key: string, text: string | null | undefined) => (text?.trim() ? [t(`problem.prompt.${key}`, { text: redactForPrompt(text.trim()) })] : [])
  const service = facts.serviceReady == null ? null : t(facts.serviceReady ? 'problem.prompt.ready' : 'problem.prompt.notReady')
  return [
    t('problem.prompt.intro'),
    '',
    ...line('what', facts.what),
    ...line('where', facts.page),
    ...line('error', facts.error),
    ...line('version', facts.version),
    ...line('service', service),
    '',
    t('problem.prompt.steps'),
    t('problem.prompt.step1', { issues: ISSUES_URL }),
    t('problem.prompt.step2'),
    t('problem.prompt.step3'),
    t('problem.prompt.step4'),
  ].join('\n')
}
