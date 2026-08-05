import { createHash } from 'node:crypto';

export const WRITING_TASTE_READINESS = Object.freeze({
  ruleCount: 3,
  evidenceCount: 6,
  sessionCount: 3,
  observationDayCount: 3,
  confirmedRuleCount: 3
});

const STATUS_LABELS = Object.freeze({
  confirmed: 'Confirmed',
  agent_confirmed: 'Observed',
  pending: 'Working hypothesis'
});

const WRITING_TERMS = Object.freeze([
  'writing', 'written', 'copywriting', 'copy', 'prose', 'voice', 'tone',
  'wording', 'headline', 'heading', 'paragraph', 'email', 'comment', 'article',
  '写作', '文案', '表达', '措辞', '语气', '标题', '段落', '叙述', '文章',
  '邮件', '评论', '说明文字'
]);

const DOMAIN_ATTRIBUTE_KEYS = Object.freeze([
  'tasteDomain', 'taste_domain', 'profileDomain', 'profile_domain',
  'preferenceDomain', 'preference_domain', 'domain'
]);

const CONTEXT_ATTRIBUTE_KEYS = Object.freeze([
  'writingContext', 'writing_context', 'tasteContext', 'taste_context',
  'context', 'appliesTo', 'applies_to'
]);

export function buildWritingTasteProfile({
  graph = { nodes: [], edges: [] },
  conflictRecords = [],
  personalSpaceId = null,
  personalProjectId = null,
  generatedAt = new Date().toISOString()
} = {}) {
  const rules = writingTasteRules(graph).filter((rule) =>
    writingRuleApplies(rule, personalProjectId));
  const conflicts = writingTasteConflicts(rules, conflictRecords);
  const conflictItemIds = new Set(conflicts.flatMap(({ item_ids: itemIds }) => itemIds));
  const decoratedRules = rules.map((rule) => ({
    ...rule,
    has_conflict: conflictItemIds.has(rule.item_id)
  }));
  const evidenceKeys = new Set();
  const sessionIds = new Set();
  const observationDays = new Set();

  for (const rule of decoratedRules) {
    for (const evidence of rule.evidence) {
      evidenceKeys.add(evidenceKey(rule.item_id, evidence));
      if (evidence.session_id) sessionIds.add(evidence.session_id);
      const day = dateKey(evidence.reference_time ?? evidence.created_at);
      if (day) observationDays.add(day);
    }
    if (rule.evidence_status === 'Confirmed') {
      evidenceKeys.add(`confirmation:${rule.item_kind}:${rule.item_id}`);
      const day = dateKey(rule.confirmed_at ?? rule.updated_at);
      if (day) observationDays.add(day);
    }
  }

  const confirmedRuleCount = decoratedRules.filter(
    ({ evidence_status: status }) => status === 'Confirmed'
  ).length;
  const observedRuleCount = decoratedRules.filter(
    ({ evidence_status: status }) => status === 'Observed'
  ).length;
  const workingHypothesisCount = decoratedRules.filter(
    ({ evidence_status: status }) => status === 'Working hypothesis'
  ).length;
  const counts = {
    rule_count: decoratedRules.length,
    evidence_count: evidenceKeys.size,
    session_count: sessionIds.size,
    observation_day_count: observationDays.size,
    confirmed_rule_count: confirmedRuleCount,
    observed_rule_count: observedRuleCount,
    working_hypothesis_count: workingHypothesisCount,
    conflict_count: conflicts.length
  };
  const standardPathReady = (
    counts.rule_count >= WRITING_TASTE_READINESS.ruleCount
    && counts.evidence_count >= WRITING_TASTE_READINESS.evidenceCount
    && counts.session_count >= WRITING_TASTE_READINESS.sessionCount
    && counts.observation_day_count >= WRITING_TASTE_READINESS.observationDayCount
    && counts.conflict_count === 0
  );
  const confirmedPathReady = (
    counts.confirmed_rule_count >= WRITING_TASTE_READINESS.confirmedRuleCount
    && counts.conflict_count === 0
  );
  const ready = standardPathReady || confirmedPathReady;
  const status = confirmedPathReady
    ? 'active'
    : standardPathReady
      ? 'preview_ready'
      : 'collecting';
  const fingerprint = ready
    ? createHash('sha256')
      .update(canonicalJson(decoratedRules.map(ruleFingerprint)))
      .digest('hex')
    : null;
  const skillVersion = fingerprint ? `v1:${fingerprint.slice(0, 24)}` : null;

  return {
    status,
    ready,
    generated_at: generatedAt,
    generated_from: 'personal_profile_graph',
    scope: {
      personal_space_id: personalSpaceId,
      personal_project_id: personalProjectId
    },
    readiness: {
      ...counts,
      standard_path_ready: standardPathReady,
      confirmed_path_ready: confirmedPathReady,
      thresholds: {
        rule_count: WRITING_TASTE_READINESS.ruleCount,
        evidence_count: WRITING_TASTE_READINESS.evidenceCount,
        session_count: WRITING_TASTE_READINESS.sessionCount,
        observation_day_count: WRITING_TASTE_READINESS.observationDayCount,
        confirmed_rule_count: WRITING_TASTE_READINESS.confirmedRuleCount
      },
      criteria: readinessCriteria(counts)
    },
    conflicts,
    rules: decoratedRules,
    skill_name: ready ? 'user-writing-taste' : null,
    skill_version: skillVersion,
    profile_markdown: ready
      ? renderWritingTasteProfile(decoratedRules, skillVersion, generatedAt)
      : null,
    agent_markdown: ready
      ? renderAgentWritingTasteSkill(decoratedRules, skillVersion, generatedAt)
      : null
  };
}

export function writingTasteRules(graph = { nodes: [], edges: [] }) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  return [
    ...nodes.map((node) => normalizeRule(node, 'entity', names)),
    ...edges.map((edge) => normalizeRule(edge, 'relationship', names))
  ]
    .filter(Boolean)
    .sort(compareRules);
}

export function isWritingTasteItem(value) {
  if (!value || typeof value !== 'object' || value.profile_aspect !== 'taste') {
    return false;
  }
  const attributes = objectValue(value.attributes);
  const explicitDomains = DOMAIN_ATTRIBUTE_KEYS.flatMap((key) => stringValues(attributes[key]));
  if (explicitDomains.length) {
    return explicitDomains.some((domain) => writingTermMatch(domain));
  }
  const searchable = [
    value.name,
    value.title,
    value.summary,
    value.instruction,
    value.fact,
    value.reasoning_summary,
    ...CONTEXT_ATTRIBUTE_KEYS.flatMap((key) => stringValues(attributes[key])),
    ...stringValues(attributes.searchTerms),
    ...stringValues(attributes.search_terms)
  ].filter(Boolean).join(' ');
  return writingTermMatch(searchable);
}

function normalizeRule(value, itemKind, names) {
  if (!isWritingTasteItem(value) || value.invalid_at) return null;
  const attributes = objectValue(value.attributes);
  const basis = objectValue(value.confirmation_basis);
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item) => item && typeof item === 'object')
    : [];
  const sourceName = itemKind === 'relationship'
    ? names.get(endpointId(value.source)) ?? value.source_name
    : null;
  const targetName = itemKind === 'relationship'
    ? names.get(endpointId(value.target)) ?? value.target_name
    : null;
  const title = itemKind === 'relationship'
    ? [sourceName, targetName].filter(Boolean).join(' → ') || value.type || value.id
    : value.name ?? value.title ?? value.id;
  const instruction = singleLine(
    value.instruction
      ?? (itemKind === 'relationship' ? value.fact : value.summary)
      ?? ''
  );
  if (!instruction) return null;
  const confirmationStatus = normalizedConfirmationStatus(value);
  const scope = value.preference_scope === 'project' ? 'project' : 'global';
  const contexts = uniqueStrings(
    CONTEXT_ATTRIBUTE_KEYS.flatMap((key) => stringValues(attributes[key]))
  );
  return {
    item_id: String(value.id),
    item_kind: itemKind,
    preference_key: String(
      value.preference_key
        ?? attributes.preferenceKey
        ?? attributes.preference_key
        ?? value.key
        ?? value.id
    ),
    title: singleLine(title),
    instruction,
    reason: singleLine(value.reasoning_summary ?? basis.quadrant_reason ?? ''),
    evidence_status: STATUS_LABELS[confirmationStatus],
    confirmation_status: confirmationStatus,
    preference_scope: scope,
    preference_project_id: scope === 'project'
      ? value.preference_project_id ?? value.defined_project_id ?? null
      : null,
    contexts,
    evidence,
    evidence_count: evidence.length + (STATUS_LABELS[confirmationStatus] === 'Confirmed' ? 1 : 0),
    session_count: new Set(evidence.map(({ session_id: sessionId }) => sessionId).filter(Boolean)).size,
    confirmed_at: basis.confirmed_at ?? null,
    updated_at: latestRuleTime(value, evidence),
    origin_quadrant: value.origin_quadrant ?? 'known_known'
  };
}

function normalizedConfirmationStatus(value) {
  const basis = objectValue(value.confirmation_basis);
  const confirmer = objectValue(basis.confirmed_by);
  if (
    value.confirmation_state_explicit === true
    && value.confirmation_status === 'confirmed'
    && ['user', 'authoritative_source'].includes(confirmer.kind)
    && basis.confirmed_at
  ) return 'confirmed';
  if (
    value.confirmation_state_explicit === true
    && value.confirmation_status === 'agent_confirmed'
    && confirmer.kind === 'agent'
    && basis.confirmed_at
    && basis.agent_policy_version
  ) return 'agent_confirmed';
  return 'pending';
}

function writingTasteConflicts(rules, conflictRecords) {
  const ruleIds = new Set(rules.map(({ item_id: itemId }) => itemId));
  const conflicts = [];
  const recordedPairs = new Set();
  for (const record of Array.isArray(conflictRecords) ? conflictRecords : []) {
    if (!record || record.status === 'resolved') continue;
    const itemIds = uniqueStrings([
      record.left_item_id,
      record.right_item_id,
      ...(Array.isArray(record.item_ids) ? record.item_ids : [])
    ]).filter((id) => ruleIds.has(id));
    if (itemIds.length < 2) continue;
    const pair = [...itemIds].sort().join('\u0000');
    recordedPairs.add(pair);
    conflicts.push({
      id: String(record.id ?? `recorded:${pair}`),
      preference_key: record.preference_key ?? null,
      item_ids: itemIds,
      source: 'recorded'
    });
  }
  const groups = new Map();
  for (const rule of rules) {
    const key = [
      rule.preference_key,
      rule.preference_scope,
      rule.preference_project_id ?? ''
    ].join('\u0000');
    const group = groups.get(key) ?? [];
    group.push(rule);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const instructions = new Set(group.map(({ instruction }) => instruction.toLocaleLowerCase()));
    if (group.length < 2 || instructions.size < 2) continue;
    const itemIds = group.map(({ item_id: itemId }) => itemId).sort();
    const pair = itemIds.join('\u0000');
    if (recordedPairs.has(pair)) continue;
    conflicts.push({
      id: `derived:${key}`,
      preference_key: group[0].preference_key,
      item_ids: itemIds,
      source: 'same_key'
    });
  }
  return conflicts;
}

function writingRuleApplies(rule, personalProjectId) {
  if (!personalProjectId) return true;
  return rule.preference_scope !== 'project'
    || rule.preference_project_id === personalProjectId;
}

function readinessCriteria(counts) {
  return [
    criterion('rules', counts.rule_count, WRITING_TASTE_READINESS.ruleCount),
    criterion('evidence', counts.evidence_count, WRITING_TASTE_READINESS.evidenceCount),
    criterion('sessions', counts.session_count, WRITING_TASTE_READINESS.sessionCount),
    criterion('days', counts.observation_day_count, WRITING_TASTE_READINESS.observationDayCount),
    criterion('confirmed', counts.confirmed_rule_count, WRITING_TASTE_READINESS.confirmedRuleCount),
    {
      key: 'conflicts',
      current: counts.conflict_count,
      target: 0,
      met: counts.conflict_count === 0
    }
  ];
}

function criterion(key, current, target) {
  return { key, current, target, met: current >= target };
}

function renderWritingTasteProfile(rules, skillVersion, generatedAt) {
  const sections = ['Confirmed', 'Observed', 'Working hypothesis']
    .map((status) => {
      const items = rules.filter(({ evidence_status: evidenceStatus }) => evidenceStatus === status);
      if (!items.length) return null;
      return `### ${status}\n${items.map(renderRuleLine).join('\n')}`;
    })
    .filter(Boolean);
  return [
    '---',
    'name: user-writing-taste',
    'description: Apply the user\'s evidence-backed writing preferences when drafting or revising text.',
    `version: ${skillVersion}`,
    '---',
    '',
    '# User Writing Taste',
    '',
    `Generated from FULI evidence at ${generatedAt}.`,
    '',
    '## Precedence',
    '',
    '1. The current request and authoritative constraints.',
    '2. Confirmed preferences in the narrowest matching context.',
    '3. Observed patterns as weaker signals.',
    '4. Working hypotheses are review material, not established user facts.',
    '',
    '## Writing preferences',
    '',
    ...sections,
    ''
  ].join('\n');
}

function renderAgentWritingTasteSkill(rules, skillVersion, generatedAt) {
  const active = rules.filter(
    ({ evidence_status: status, has_conflict: hasConflict }) =>
      status !== 'Working hypothesis' && !hasConflict
  );
  return [
    '---',
    'name: user-writing-taste',
    'description: Use when drafting or revising writing where the user\'s established style should guide judgment.',
    `version: ${skillVersion}`,
    '---',
    '',
    '# User Writing Taste · Agent View',
    '',
    `Generated from FULI effective writing preferences at ${generatedAt}.`,
    '',
    '## Rules',
    '',
    active.length
      ? active.map(renderRuleLine).join('\n')
      : 'No confirmed or observed writing rule is currently active.',
    ''
  ].join('\n');
}

function renderRuleLine(rule) {
  const scope = rule.preference_scope === 'project'
    ? `project:${rule.preference_project_id ?? 'unknown'}`
    : 'global';
  const contexts = rule.contexts.length ? `; context: ${rule.contexts.join(', ')}` : '';
  return `- **${rule.evidence_status} · ${scope} · ${rule.preference_key}** ${rule.instruction}${contexts}`;
}

function ruleFingerprint(rule) {
  return {
    item_id: rule.item_id,
    item_kind: rule.item_kind,
    preference_key: rule.preference_key,
    instruction: rule.instruction,
    evidence_status: rule.evidence_status,
    preference_scope: rule.preference_scope,
    preference_project_id: rule.preference_project_id,
    contexts: [...rule.contexts].sort(),
    has_conflict: rule.has_conflict
  };
}

function compareRules(left, right) {
  const statusOrder = { Confirmed: 0, Observed: 1, 'Working hypothesis': 2 };
  return statusOrder[left.evidence_status] - statusOrder[right.evidence_status]
    || timeValue(right.updated_at) - timeValue(left.updated_at)
    || left.preference_key.localeCompare(right.preference_key);
}

function latestRuleTime(value, evidence) {
  const revisionTimes = Array.isArray(value.revisions)
    ? value.revisions.map((revision) => revision?.created_at).filter(Boolean)
    : [];
  const evidenceTimes = evidence.flatMap((item) => [item.reference_time, item.created_at]).filter(Boolean);
  const values = [
    ...revisionTimes,
    value.last_human_changed_at,
    value.last_used_at,
    ...evidenceTimes,
    value.created_at
  ].filter(Boolean);
  return values.sort((left, right) => timeValue(right) - timeValue(left))[0] ?? null;
}

function evidenceKey(itemId, evidence) {
  return String(
    evidence.id
      ?? [
        evidence.session_id,
        evidence.source_turn_id,
        evidence.reference_time,
        evidence.source_description,
        itemId
      ].filter(Boolean).join(':')
  );
}

function writingTermMatch(value) {
  const text = String(value ?? '').toLocaleLowerCase();
  return WRITING_TERMS.some((term) => text.includes(term));
}

function endpointId(value) {
  return value && typeof value === 'object' ? value.id : value;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValues(value) {
  if (Array.isArray(value)) return value.flatMap(stringValues);
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function timeValue(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
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
