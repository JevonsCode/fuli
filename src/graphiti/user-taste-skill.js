import { createHash } from 'node:crypto';

const DEFAULT_ITEM_LIMIT = 64;
const DEFAULT_RECOMMENDATION_LIMIT = 12;

const ASPECT_LABELS = Object.freeze({
  taste: 'Taste',
  personality: 'Personality',
  judgment_preference: 'Judgment preferences'
});

const STATUS_LABELS = Object.freeze({
  confirmed: 'Confirmed',
  agent_confirmed: 'Observed',
  pending: 'Working hypothesis'
});

export function buildUserTasteSkill({
  preferences = [],
  taskPrompt = null,
  personalSpaceId = null,
  personalProjectId = null,
  generatedAt = new Date().toISOString(),
  maxItems = DEFAULT_ITEM_LIMIT,
  recommendationLimit = DEFAULT_RECOMMENDATION_LIMIT
} = {}) {
  if (!Array.isArray(preferences)) {
    throw new TypeError('User taste preferences must be an array');
  }
  const normalized = preferences
    .map((item, index) => normalizePreference(item, index))
    .filter((item) => item.instruction && item.preferenceKey);
  const active = normalized.filter((item) => item.confirmationStatus !== 'pending');
  const bounded = active.slice(0, boundedLimit(maxItems, DEFAULT_ITEM_LIMIT));
  const recommendations = recommendUserTaste(
    bounded,
    taskPrompt,
    recommendationLimit
  );
  const sourceFingerprint = createHash('sha256')
    .update(canonicalJson(active.map(preferenceFingerprint)))
    .digest('hex');

  return {
    skill_name: 'user-taste',
    skill_version: `v1:${sourceFingerprint.slice(0, 24)}`,
    generated_at: generatedAt,
    generated_from: 'effective_preferences',
    source_count: bounded.length,
    total_source_count: active.length,
    pending_source_count: normalized.length - active.length,
    truncated: active.length > bounded.length,
    scope: {
      personal_space_id: personalSpaceId,
      personal_project_id: personalProjectId
    },
    recommendations,
    markdown: renderUserTasteSkill({
      preferences: bounded,
      recommendations,
      skillVersion: `v1:${sourceFingerprint.slice(0, 24)}`,
      generatedAt
    })
  };
}

export function recommendUserTaste(
  preferences,
  taskPrompt = null,
  limit = DEFAULT_RECOMMENDATION_LIMIT
) {
  const promptTokens = tokenize(taskPrompt);
  const ranked = preferences.map((preference) => {
    const preferenceTokens = tokenize([
      preference.title,
      preference.instruction,
      preference.reason,
      ...preference.searchTerms
    ].join(' '));
    const matchedTerms = [...promptTokens]
      .filter((token) => preferenceTokens.has(token))
      .sort();
    const matchScore = promptTokens.size === 0
      ? 0
      : Number(Math.min(1, matchedTerms.length / Math.min(promptTokens.size, 6)).toFixed(4));
    return {
      preference_key: preference.preferenceKey,
      title: preference.title,
      instruction: preference.instruction,
      profile_aspect: preference.profileAspect,
      preference_scope: preference.preferenceScope,
      preference_project_id: preference.preferenceProjectId,
      evidence_status: STATUS_LABELS[preference.confirmationStatus]
        ?? preference.confirmationStatus,
      match_score: matchScore,
      matched_terms: matchedTerms,
      reason: matchedTerms.length
        ? `Matches prior preference terms: ${matchedTerms.join(', ')}`
        : 'Available as a default profile rule; no task-specific term matched.'
    };
  });
  return ranked
    .sort((left, right) => right.match_score - left.match_score)
    .slice(0, boundedLimit(limit, DEFAULT_RECOMMENDATION_LIMIT));
}

export function renderUserTasteSkill({
  preferences,
  recommendations = [],
  skillVersion,
  generatedAt
}) {
  const sections = [];
  for (const [aspect, label] of Object.entries(ASPECT_LABELS)) {
    const items = preferences.filter((preference) => preference.profileAspect === aspect);
    if (!items.length) continue;
    sections.push(`### ${label}`);
    sections.push(items.map(renderPreferenceLine).join('\n'));
  }
  if (!sections.length) {
    sections.push('No effective personal taste preferences are available yet.');
  }

  const recommendationLines = recommendations.length
    ? recommendations.slice(0, 8).map((item) => (
      `- **${item.title}** — ${item.instruction} ` +
      `(${item.evidence_status}; ${item.reason})`
    )).join('\n')
    : '- No task-specific recommendation is available.';

  return [
    '---',
    'name: user-taste',
    'description: Apply the user\'s current evidence-backed taste and working preferences when making recommendations or judgment calls.',
    `version: ${skillVersion}`,
    '---',
    '',
    '# User Taste · Generated',
    '',
    `Generated from FULI effective preferences at ${generatedAt}. This is a derived, read-time projection; it does not overwrite a user-authored taste Skill.`,
    '',
    '## Precedence',
    '',
    '1. The current user request and authoritative project constraints.',
    '2. Confirmed preferences in the narrowest matching scope.',
    '3. Observed preferences as weaker signals; never present them as user-confirmed.',
    '4. Explain the matching rule and material tradeoff when making a recommendation.',
    '',
    '## Active profile rules',
    '',
    sections.join('\n\n'),
    '',
    '## Task recommendations',
    '',
    recommendationLines,
    ''
  ].join('\n');
}

function normalizePreference(item, index) {
  const value = item && typeof item === 'object' ? item : {};
  const attributes = value.attributes && typeof value.attributes === 'object'
    ? value.attributes
    : {};
  const id = String(value.id ?? value.preference_key ?? value.key ?? `preference-${index}`);
  const searchTerms = Array.isArray(attributes.searchTerms)
    ? attributes.searchTerms.filter((term) => typeof term === 'string' && term.trim())
    : [];
  return {
    id,
    preferenceKey: String(
      value.preference_key ?? value.preferenceKey ?? value.key ?? id
    ),
    title: singleLine(value.title ?? value.preference_key ?? value.key ?? id),
    instruction: singleLine(value.instruction ?? value.summary ?? ''),
    reason: singleLine(value.reason ?? value.reasoning_summary ?? ''),
    profileAspect: value.profile_aspect ?? value.profileAspect ?? 'taste',
    preferenceScope: value.preference_scope ?? value.preferenceScope ?? 'global',
    preferenceProjectId: value.preference_project_id
      ?? value.preferenceProjectId
      ?? null,
    confirmationStatus: value.confirmation_status
      ?? value.confirmationStatus
      ?? 'confirmed',
    searchTerms
  };
}

function preferenceFingerprint(preference) {
  return {
    preferenceKey: preference.preferenceKey,
    title: preference.title,
    instruction: preference.instruction,
    reason: preference.reason,
    profileAspect: preference.profileAspect,
    preferenceScope: preference.preferenceScope,
    preferenceProjectId: preference.preferenceProjectId,
    confirmationStatus: preference.confirmationStatus,
    searchTerms: [...preference.searchTerms].sort()
  };
}

function renderPreferenceLine(preference) {
  const status = STATUS_LABELS[preference.confirmationStatus]
    ?? preference.confirmationStatus;
  const scope = preference.preferenceScope === 'project'
    ? `project:${preference.preferenceProjectId ?? 'active'}`
    : 'global';
  return `- **${status} · ${scope} · ${preference.preferenceKey}** ${preference.instruction}`;
}

function tokenize(value) {
  const normalized = String(value ?? '').toLocaleLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
  const cjkRuns = normalized.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length >= 2) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return tokens;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

function boundedLimit(value, fallback) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : fallback;
}
