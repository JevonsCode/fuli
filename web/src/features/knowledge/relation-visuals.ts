import { t } from '@/i18n'

export interface RelationVisual {
  type: string
  label: string
  description: string
  iconPath: string
}

type RelationVisualDefinition = {
  messageKey: string
  iconPath: string
}

export const RELATION_ICON_VIEWBOX = '0 0 24 24'

const ICONS = {
  assessment: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 12l2.7 2.7L16 9',
  code: 'M8 9l-4 3 4 3M16 9l4 3-4 3M14 5l-4 14',
  decision: 'M5 4h14v16H5zM8 12l2.5 2.5L16 9',
  folder: 'M3 6h7l2 2h9v11H3z',
  hierarchy: 'M9 3h6v4H9zM4 17h6v4H4zM14 17h6v4h-6zM12 7v5M7 12h10M7 12v5M17 12v5',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.8-1.7',
  measure: 'M4 16 16 4l4 4L8 20zM13 7l4 4M10 10l2 2M7 13l4 4',
  purpose: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  scope: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9 12l2 2 4-4',
  source: 'M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h6',
  transfer: 'M4 7h11M12 4l3 3-3 3M20 17H9M12 14l-3 3 3 3',
} satisfies Record<string, string>

const RELATION_VISUALS: Record<string, RelationVisualDefinition> = {
  PART_OF: {
    messageKey: 'PART_OF',
    iconPath: ICONS.hierarchy,
  },
  HAS_SOURCE: {
    messageKey: 'HAS_SOURCE',
    iconPath: ICONS.source,
  },
  HAS_PURPOSE: {
    messageKey: 'HAS_PURPOSE',
    iconPath: ICONS.purpose,
  },
  HAS_SCOPE: {
    messageKey: 'HAS_SCOPE',
    iconPath: ICONS.scope,
  },
  GOVERNS: {
    messageKey: 'GOVERNS',
    iconPath: ICONS.shield,
  },
  HAS_TECHNICAL_SUMMARY: {
    messageKey: 'HAS_TECHNICAL_SUMMARY',
    iconPath: ICONS.code,
  },
  ASSESSED_AS: {
    messageKey: 'ASSESSED_AS',
    iconPath: ICONS.assessment,
  },
  MEASURES: {
    messageKey: 'MEASURES',
    iconPath: ICONS.measure,
  },
  CONTAINS_PROJECT: {
    messageKey: 'CONTAINS_PROJECT',
    iconPath: ICONS.folder,
  },
  USES_KNOWLEDGE_FROM: {
    messageKey: 'USES_KNOWLEDGE_FROM',
    iconPath: ICONS.transfer,
  },
  USES_EXTERNAL_KNOWLEDGE: {
    messageKey: 'USES_EXTERNAL_KNOWLEDGE',
    iconPath: ICONS.transfer,
  },
  DEPENDS_ON: {
    messageKey: 'DEPENDS_ON',
    iconPath: ICONS.link,
  },
  PROVIDES_TO: {
    messageKey: 'PROVIDES_TO',
    iconPath: ICONS.transfer,
  },
  SHARES_CAPABILITY_WITH: {
    messageKey: 'SHARES_CAPABILITY_WITH',
    iconPath: ICONS.link,
  },
  RELATED_TO: {
    messageKey: 'RELATED_TO',
    iconPath: ICONS.link,
  },
  HAS_DECISION: {
    messageKey: 'HAS_DECISION',
    iconPath: ICONS.decision,
  },
}

const FALLBACK_VISUAL: RelationVisualDefinition = {
  messageKey: 'fallback',
  iconPath: ICONS.link,
}

const KNOWN_RELATION_TOKEN = new RegExp(
  `\\b(${Object.keys(RELATION_VISUALS).join('|')})\\b`,
  'g',
)

export function relationVisual(type: string): RelationVisual {
  const normalizedType = type.trim().toUpperCase()
  const definition = RELATION_VISUALS[normalizedType] ?? FALLBACK_VISUAL
  const messagePrefix = `knowledge.domain.relations.${definition.messageKey}`
  return {
    type,
    label: t(`${messagePrefix}.label`),
    description: t(`${messagePrefix}.description`),
    iconPath: definition.iconPath,
  }
}

export function localizeRelationTokens(value: string) {
  return value.replace(
    KNOWN_RELATION_TOKEN,
    (type) => t('knowledge.domain.relations.quoted', {
      label: relationVisual(type).label,
    }),
  )
}

export function uniqueRelationVisuals(types: string[]) {
  const seen = new Set<string>()
  const visuals: RelationVisual[] = []
  for (const type of types) {
    const normalizedType = type.trim().toUpperCase()
    if (!normalizedType || seen.has(normalizedType)) continue
    seen.add(normalizedType)
    visuals.push(relationVisual(type))
  }
  return visuals
}
