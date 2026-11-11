import type { AiTaskId } from '@/features/ai-help/ai-task-prompts'
import { messages, SUPPORTED_LOCALES } from '@/i18n'

// Every term the glossary can explain. Labels reuse the strings the pages
// already show, so a click on visible text finds its term in either language.
// A tagged term is found only through its element's data-term: its label is a
// common word (全部, 我的, 知识) that also appears where it means something else.
export type GlossaryGroup = 'quadrant' | 'review' | 'profile' | 'work' | 'presence' | 'weight' | 'authorship' | 'destination' | 'section' | 'memory' | 'occupation' | 'tonborg' | 'setting' | 'concept' | 'task'
// aiTask: the 「让 AI 来做」 prompt a card's 「?」 offers (features/ai-help); a task term without one is the person's own.
export interface GlossaryTerm { id: string; group: GlossaryGroup; labelKey: string; bodyKey: string; tagged?: true; aiTask?: AiTaskId }

const term = (group: GlossaryGroup, key: string, labelKey: string, bodyKey: string): GlossaryTerm =>
  ({ id: `${group}.${key}`, group, labelKey, bodyKey })
const taggedTerm = (group: GlossaryGroup, key: string, labelKey: string, bodyKey: string): GlossaryTerm =>
  ({ ...term(group, key, labelKey, bodyKey), tagged: true })

// The 「?」 topics: [id, the area's visible title, its prompt or null when only the person does it].
const AI_HELP_TOPICS: readonly (readonly [string, string, AiTaskId | null])[] = [
  ['models', 'modelSettings.title', 'models'],
  ['capture', 'settings.groups.capture', 'capture'],
  ['captureProjects', 'capture.settings.title', 'capture'],
  ['access', 'settings.groups.access', null],
  ['aiPermissions', 'agentDelegation.title', null],
  ['judgment', 'judgment.settings.link', null],
  ['notifications', 'settings.notifications.title', 'settings'],
  ['launchers', 'settings.conversationLaunchers.title', 'settings'],
  ['lan', 'settings.groups.lan', 'lan'],
  ['ports', 'settings.ports.title', 'settings'],
  ['interface', 'settings.groups.interface', null],
  ['runtime', 'settings.groups.runtime', 'settings'],
  ['dataFormat', 'dataFormat.title', null],
  ['version', 'settings.version.title', 'update'],
  ['clients', 'settings.connection.title', 'clients'],
  ['clientLinks', 'clientLinks.title', 'clients'],
  ['storage', 'settings.storage.title', 'storage'],
  ['diagnostics', 'settings.diagnostics.title', null],
  ['peer', 'settings.peer.title', 'lan'],
  ['connections', 'pages.connections.externalTitle', 'connections'],
  ['decisions', 'shell.sections.askedYou', 'decisions'],
  ['workbench', 'shell.destinations.agents', 'workbench'],
  ['knowledge', 'shell.sections.knowledge', 'knowledge'],
]

// Every sidebar destination and every top-bar section tab, so each page can say what it is for.
const { destinations, sections } = messages['zh-CN'].shell

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  // FULI's own words: an Agent, the team, a group discussion, a reply's receipt.
  ...['fla', 'flas', 'flg', 'workbench', 'workflow', 'receipt'].map(key =>
    term('concept', key, `glossary.concept.${key}.label`, `glossary.concept.${key}.body`)),
  // The current person (MeLink); tagged because 我 also starts many sentences.
  taggedTerm('concept', 'me', 'common.me.name', 'glossary.concept.me'),
  ...['known_known', 'known_unknown', 'unknown_known', 'unknown_unknown'].map(key =>
    term('quadrant', key, `knowledge.domain.quadrants.${key}`, `knowledge.domain.quadrants.descriptions.${key}`)),
  ...['confirmed', 'agent_confirmed', 'ai_reviewed', 'pending'].map(key =>
    term('review', key, `knowledge.domain.reviewStates.${key}`, `glossary.review.${key}`)),
  ...['taste', 'personality', 'judgment_preference'].map(key =>
    term('profile', key, `knowledge.domain.profiles.${key}`, `glossary.profile.${key}`)),
  ...['running', 'queued', 'backlog', 'paused', 'blocked', 'awaiting_review', 'awaiting_recruitment', 'none', 'ended'].map(key =>
    term('work', key, `agentRedesign.workStatus.${key}`, `glossary.work.${key}`)),
  term('work', 'rawReason', 'taskReason.raw', 'glossary.work.rawReason'),
  // The person's own end of a block; tagged because the button text is an action.
  taggedTerm('work', 'unblock', 'taskBlocker.clear.action', 'glossary.work.unblock'),
  // Team work: the card for a task several FLAs share, and the island above the dock.
  taggedTerm('work', 'teamCard', 'teamWork.glossary.teamCard', 'glossary.work.teamCard'),
  taggedTerm('work', 'island', 'teamWork.glossary.island', 'glossary.work.island'),
  ...['working', 'waiting', 'idle', 'error'].map(key =>
    term('presence', key, `glossary.presence.${key}.label`, `glossary.presence.${key}.body`)),
  ...['pending', 'agent', 'person'].map(key =>
    term('weight', key, `glossary.weight.${key}.label`, `glossary.weight.${key}.body`)),
  // Who wrote a project profile field; the author chip carries the id.
  ...['person', 'both', 'agent'].map(key =>
    taggedTerm('authorship', key, `glossary.authorship.${key}.label`, `glossary.authorship.${key}.body`)),
  ...Object.keys(destinations).map(key =>
    taggedTerm('destination', key, `shell.destinations.${key}`, `glossary.destination.${key}`)),
  ...Object.keys(sections).map(key =>
    taggedTerm('section', key, `shell.sections.${key}`, `glossary.section.${key}`)),
  ...['preferenceCount'].map(key =>
    taggedTerm('memory', key, `glossary.memory.${key}.label`, `glossary.memory.${key}.body`)),
  taggedTerm('memory', 'current', 'common.status.current', 'glossary.memory.current'),
  taggedTerm('memory', 'history', 'knowledge.workspace.workspace.view.history', 'glossary.memory.history'),
  taggedTerm('memory', 'all', 'common.status.all', 'glossary.memory.all'),
  // Ids other pages tag with data-term (occupations, the Tonborg policy).
  taggedTerm('occupation', 'catalog', 'shell.sections.occupations', 'glossary.occupation.catalog'),
  taggedTerm('occupation', 'archived', 'occupations.stats.archived', 'glossary.occupation.archived'),
  taggedTerm('occupation', 'active', 'occupations.stats.active', 'glossary.occupation.active'),
  taggedTerm('occupation', 'agentCount', 'glossary.occupation.agentCountLabel', 'glossary.occupation.agentCount'),
  term('occupation', 'hr', 'agentProfiles.roles.hr', 'glossary.occupation.hr'),
  ...['manual', 'shared', 'autonomous'].map(key =>
    taggedTerm('tonborg', key, `judgment.mode.${key}`, `glossary.tonborg.${key}`)),
  taggedTerm('tonborg', 'escalate', 'judgment.workbench.outcome.escalate', 'glossary.tonborg.escalate'),
  term('setting', 'agentNamingStyle', 'preferences.home.naming.title', 'glossary.setting.agentNamingStyle'),
  term('setting', 'topicPromotion', 'settings.topicPromotion.title', 'glossary.setting.topicPromotion'),
  term('setting', 'diagnostics', 'settings.diagnostics.title', 'glossary.setting.diagnostics'),
  // Each card's and page area's 「?」: what it is for and how the person's own Agent does it.
  ...AI_HELP_TOPICS.map(([key, labelKey, aiTask]) =>
    ({ ...taggedTerm('task', key, labelKey, `aiHelp.topics.${key}`), ...(aiTask ? { aiTask } : {}) })),
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
  if (entry.tagged) continue
  for (const locale of SUPPORTED_LOCALES) {
    const label = messageAt(locale, entry.labelKey)
    if (typeof label === 'string' && !byLabel.has(normalize(label))) byLabel.set(normalize(label), entry)
  }
}

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

/** The term a 「?」 names by id; undefined for an unknown id. */
export const termById = (id: string) => byId.get(id)
