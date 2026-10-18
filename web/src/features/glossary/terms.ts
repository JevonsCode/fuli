import { messages, SUPPORTED_LOCALES } from '@/i18n'

// Every term the glossary can explain. Labels reuse the strings the pages
// already show, so a click on visible text finds its term in either language.
export type GlossaryGroup = 'quadrant' | 'review' | 'profile' | 'work' | 'presence' | 'weight'
export interface GlossaryTerm { id: string; group: GlossaryGroup; labelKey: string; bodyKey: string }

const term = (group: GlossaryGroup, key: string, labelKey: string, bodyKey: string): GlossaryTerm =>
  ({ id: `${group}.${key}`, group, labelKey, bodyKey })

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  ...['known_known', 'known_unknown', 'unknown_known', 'unknown_unknown'].map(key =>
    term('quadrant', key, `knowledge.domain.quadrants.${key}`, `knowledge.domain.quadrants.descriptions.${key}`)),
  ...['confirmed', 'agent_confirmed', 'ai_reviewed', 'pending'].map(key =>
    term('review', key, `knowledge.domain.reviewStates.${key}`, `glossary.review.${key}`)),
  ...['taste', 'personality', 'judgment_preference'].map(key =>
    term('profile', key, `knowledge.domain.profiles.${key}`, `glossary.profile.${key}`)),
  ...['running', 'queued', 'paused', 'blocked', 'awaiting_review', 'awaiting_recruitment', 'none', 'ended'].map(key =>
    term('work', key, `agentRedesign.workStatus.${key}`, `glossary.work.${key}`)),
  ...['working', 'waiting', 'idle', 'error'].map(key =>
    term('presence', key, `glossary.presence.${key}.label`, `glossary.presence.${key}.body`)),
  ...['pending', 'agent', 'person'].map(key =>
    term('weight', key, `glossary.weight.${key}.label`, `glossary.weight.${key}.body`)),
]

const byId = new Map(GLOSSARY_TERMS.map(entry => [entry.id, entry]))

function messageAt(locale: string, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) =>
    node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, messages[locale as keyof typeof messages])
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()

// Visible label (any supported locale) → term. Quadrant and review labels are
// unique; where a label repeats across groups the first registered group wins.
const byLabel = new Map<string, GlossaryTerm>()
for (const entry of GLOSSARY_TERMS) {
  for (const locale of SUPPORTED_LOCALES) {
    const label = messageAt(locale, entry.labelKey)
    if (typeof label === 'string' && !byLabel.has(normalize(label))) byLabel.set(normalize(label), entry)
  }
}

export function glossaryTerm(id: string): GlossaryTerm | undefined { return byId.get(id) }

const MAX_LABEL = 24
const MAX_DEPTH = 4

// The term under a click: an explicit data-term wins; otherwise a short
// element whose own text is a known label. Long text is content, not a term.
export function findTerm(target: EventTarget | null): { term: GlossaryTerm; element: HTMLElement } | undefined {
  if (!(target instanceof Element)) return undefined
  const tagged = target.closest<HTMLElement>('[data-term]')
  const explicit = tagged?.dataset.term && byId.get(tagged.dataset.term)
  if (tagged && explicit) return { term: explicit, element: tagged }
  let element: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement
  for (let depth = 0; element && depth < MAX_DEPTH; depth++, element = element.parentElement) {
    const text = element.textContent ?? ''
    if (text.length > MAX_LABEL) return undefined
    const match = byLabel.get(normalize(text))
    if (match) return { term: match, element }
  }
  return undefined
}
