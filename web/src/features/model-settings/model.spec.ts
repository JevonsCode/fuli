import { describe, expect, it } from 'vitest'

import {
  costValue, roleDraft, roleEdit, roleSummary, rolesSharing, tokenValue, usageParts, usageRows, usageWindowStart, withConnection, withProject,
  type ModelRolesPayload, type UsageGroup,
} from './model'

// Synthetic settings only: two roles sharing one local connection.
const payload = (): ModelRolesPayload => ({
  state: 'ok', error: null, revision: 'r'.repeat(64),
  connections: {
    'local-qwen': { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen-test', secretRef: 'local-ref',
      reasoningEffort: 'none', pricing: { currency: 'USD', inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.2, cachedInputPerMillionTokens: 0.05 } },
    jev: { protocol: 'typesafe_systemone', endpoint: 'https://api.example.test/v1', model: 'jev-test', secretRef: 'jev-ref',
      reasoningEffort: null, pricing: null },
  },
  roles: [
    { role: 'assistant', state: 'not_configured', answeredBy: 'current_session' },
    { role: 'bole', state: 'disabled', answeredBy: 'current_session',
      connection: { id: 'local-qwen', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', model: 'qwen-test', secretRef: 'local-ref' },
      allowedOperations: [], egress: { approvedProjects: [], allowUnassigned: false }, budget: null, fallbackToSession: false },
    { role: 'jefa', state: 'not_configured', answeredBy: 'current_session' },
    { role: 'tonborg', state: 'enabled', answeredBy: 'model_api',
      connection: { id: 'local-qwen', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', model: 'qwen-test', secretRef: 'local-ref' },
      allowedOperations: ['knowledge_review'], egress: { approvedProjects: [{ personalSpaceId: 's', personalProjectId: 'alpha' }], allowUnassigned: true },
      budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000, maxCostPerWindow: 0.5 },
      fallbackToSession: true },
  ],
  operations: { tonborg: ['knowledge_review', 'executor_routing', 'task_acceptance'] },
})

describe('model settings drafts', () => {
  it('saves exactly what was read, with the revision it was read at', () => {
    const data = payload()
    const body = roleEdit(roleDraft(data, 'tonborg'), data.revision)
    expect(body).toEqual({
      revision: data.revision,
      connectionId: 'local-qwen',
      connection: { ...data.connections['local-qwen'] },
      settings: {
        enabled: true, allowedOperations: ['knowledge_review'],
        egress: { approvedProjects: [{ personalSpaceId: 's', personalProjectId: 'alpha' }], allowUnassigned: true },
        budget: { maxInputTokens: 4000, maxOutputTokens: 400, timeoutMs: 30_000, windowHours: 24, maxTokensPerWindow: 100_000, maxCostPerWindow: 0.5 },
        fallbackToSession: true,
      },
    })
    expect(JSON.stringify(body)).not.toMatch(/apiKey|"key"/)
  })

  it('starts an unconfigured role on its own new connection with bounded defaults and its wired task types', () => {
    const draft = roleDraft(payload(), 'jefa')
    expect(draft).toMatchObject({ enabled: false, connectionId: 'jefa', endpoint: '', operations: '', approvedProjects: [],
      maxInputTokens: '8000', timeoutSeconds: '60', fallbackToSession: true })
    expect(roleDraft(payload(), 'tonborg').operations).toBe('knowledge_review')
    const edit = roleEdit({ ...draft, secretRef: '  ', maxCostPerWindow: '3' }, null)
    expect(edit.connection.secretRef).toBeNull()
    // Without prices a cost cap is never sent.
    expect(edit.settings.budget.maxCostPerWindow).toBeNull()
    expect(edit.connection.pricing).toBeNull()
  })

  it('switches connections, names who shares one, and toggles egress projects', () => {
    const data = payload()
    const draft = withConnection(roleDraft(data, 'bole'), data, 'jev')
    expect(draft).toMatchObject({ connectionId: 'jev', protocol: 'typesafe_systemone', secretRef: 'jev-ref', priced: false })
    expect(roleEdit(draft, null).connection.reasoningEffort).toBeNull()
    expect(rolesSharing(data, 'local-qwen', 'bole')).toEqual(['tonborg'])
    const added = withProject(draft, { personalSpaceId: 's', personalProjectId: 'beta' }, true)
    expect(withProject(added, { personalSpaceId: 's', personalProjectId: 'beta' }, false).approvedProjects).toEqual([])
    expect(roleEdit({ ...draft, operations: 'a_b, c_d，e_f' }, null).settings.allowedOperations).toEqual(['a_b', 'c_d', 'e_f'])
  })
})

const group = (overrides: Partial<UsageGroup>): UsageGroup => ({
  role: 'tonborg', provider: 'openai_chat@127.0.0.1:11434', model: 'qwen-test', actualModels: ['qwen-test'], channel: 'model_api',
  requests: 3, attempts: 4, failedAttempts: 1,
  tokens: { input: { reported: 300, unknownAttempts: 1 }, output: { reported: 60, unknownAttempts: 1 }, total: { reported: 360, unknownAttempts: 1 } },
  estimatedCost: null, ...overrides,
})

describe('model role rows', () => {
  it('sums a row up in one line: who answers, the service, and how its operation runs', () => {
    const [assistant, , , tonborg] = payload().roles
    expect(roleSummary(assistant!)).toBe('当前会话')
    expect(roleSummary({ ...tonborg!, trust: { operation: 'knowledge_review', suggestionsOnly: true, warningSeen: true, warningSeenAt: null,
      warningVersion: 1, revision: 1, status: 'suggestion', reason: 'suggestions_only', evaluation: null } }))
      .toBe('自己的模型 · OpenAI 兼容 · 127.0.0.1:11434 · 只给建议')
  })
})

describe('model usage', () => {
  it('keeps unknown usage unknown with its count, never 0', () => {
    expect(tokenValue({ reported: null, unknownAttempts: 2 }, 2)).toEqual({ kind: 'unknown', unknown: 2 })
    // A subset no attempt reported is absent from the group: every attempt is unknown.
    expect(tokenValue(undefined, 4)).toEqual({ kind: 'unknown', unknown: 4 })
    expect(usageParts(tokenValue(undefined, 4), 'zh-CN')).toEqual({ value: '未上报 · 4 次', note: '' })
    expect(usageParts(tokenValue({ reported: 1200, unknownAttempts: 1 }, 2), 'zh-CN')).toEqual({ value: '1,200', note: '（另 1 次未上报）' })
    expect(usageParts(tokenValue({ reported: 0, unknownAttempts: 0 }, 1), 'zh-CN')).toEqual({ value: '0', note: '' })
    expect(costValue(group({}))).toEqual({ kind: 'unknown', unknown: 4 })
    const priced = costValue(group({ estimatedCost: { amount: 0.0012, currency: 'USD', basis: 'estimate', unknownAttempts: 0 } }))
    expect(usageParts(priced, 'en-US', 'USD').value).toBe('$0.0012')
  })

  it('lists model calls and current-session fallbacks apart, with bars only for known totals', () => {
    const rows = usageRows([
      group({}),
      group({ role: 'bole', tokens: { total: { reported: 90, unknownAttempts: 0 } } }),
      group({ role: 'jefa', channel: 'session', provider: null, model: null, actualModels: [],
        tokens: { total: { reported: null, unknownAttempts: 2 } } }),
    ])
    expect(rows.model.map(row => [row.group.role, row.share])).toEqual([['tonborg', 1], ['bole', 0.25]])
    expect(rows.session.map(row => [row.group.role, row.share])).toEqual([['jefa', null]])
  })

  it('starts today at local midnight and the longer ranges counted back from now', () => {
    const now = new Date(2026, 9, 23, 15, 30)
    expect(usageWindowStart('today', now)).toBe(new Date(2026, 9, 23).toISOString())
    expect(usageWindowStart('7d', now)).toBe(new Date(now.getTime() - 7 * 86_400_000).toISOString())
    expect(usageWindowStart('30d', now)).toBe(new Date(now.getTime() - 30 * 86_400_000).toISOString())
  })
})
