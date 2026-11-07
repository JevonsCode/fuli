import { describe, expect, it } from 'vitest'

import {
  callParts, roleDraft, roleEdit, rolesSharing, tokenValue, usageCells, usageParts, usageRowNote, usageRows, usageWindowStart, withConnection, withProject,
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

  it('starts an unconfigured role on its own new connection with no limits and its wired task types', () => {
    const draft = roleDraft(payload(), 'jefa')
    expect(draft).toMatchObject({ enabled: false, connectionId: 'jefa', endpoint: '', operations: '', approvedProjects: [],
      maxInputTokens: '', timeoutSeconds: '', maxTokensPerWindow: '', fallbackToSession: true })
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
  requests: 3, failedRequests: 0, attempts: 4, failedAttempts: 1, unreportedAttempts: 1, unreportedFailedAttempts: 1,
  tokens: { input: { reported: 300, unknownAttempts: 1 }, output: { reported: 60, unknownAttempts: 1 }, total: { reported: 360, unknownAttempts: 1 } },
  ...overrides,
})

describe('model usage', () => {
  it('keeps unknown usage unknown, never 0, and leaves the row note tries out of each cell', () => {
    expect(tokenValue({ reported: null, unknownAttempts: 2 })).toEqual({ kind: 'unknown' })
    expect(tokenValue(undefined)).toEqual({ kind: 'unknown' })
    expect(usageParts(tokenValue(undefined), 'zh-CN')).toEqual({ value: '没返回', note: '' })
    expect(usageParts(tokenValue({ reported: 1200, unknownAttempts: 1 }), 'zh-CN')).toEqual({ value: '1,200', note: '（另 1 次没返回）' })
    expect(usageParts(tokenValue({ reported: 1200, unknownAttempts: 3 }, 2), 'zh-CN')).toEqual({ value: '1,200', note: '（另 1 次没返回）' })
    expect(usageParts(tokenValue({ reported: 1200, unknownAttempts: 2 }, 2), 'zh-CN')).toEqual({ value: '1,200', note: '' })
    expect(usageParts(tokenValue({ reported: 0, unknownAttempts: 0 }), 'zh-CN')).toEqual({ value: '0', note: '' })
  })

  it('says tries without usage once per row, naming them failed only when they all failed', () => {
    expect(usageRowNote(group({}), 'zh-CN')).toBe('1 次失败的尝试没返回用量，上面的数没算它们。')
    expect(usageRowNote(group({ unreportedFailedAttempts: 0 }), 'zh-CN')).toBe('另有 1 次尝试没返回用量，上面的数没算它们。')
    expect(usageRowNote(group({ unreportedAttempts: 0, unreportedFailedAttempts: 0 }), 'zh-CN')).toBe('')
    // When nothing came back at all, each cell already says 没返回.
    expect(usageRowNote(group({ unreportedAttempts: 4 }), 'zh-CN')).toBe('')
    expect(usageCells(group({}), 'zh-CN')).toEqual([
      { key: 'input', value: '300', note: '' }, { key: 'output', value: '60', note: '' },
    ])
    expect(usageCells(group({ tokens: { input: { reported: 9, unknownAttempts: 1 }, cachedInput: { reported: 0, unknownAttempts: 2 } } }), 'zh-CN'))
      .toEqual([{ key: 'input', value: '9', note: '' }, { key: 'output', value: '没返回', note: '' }, { key: 'cache', value: '0', note: '（另 1 次没返回）' }])
  })

  it('counts failures in calls and keeps the tries apart, so the numbers add up', () => {
    expect(callParts(group({ requests: 38, failedRequests: 19, attempts: 66, failedAttempts: 47 }), 'zh-CN'))
      .toEqual({ value: '38 次', failed: '19 次失败', note: '（含重试共试了 66 次）' })
    expect(callParts(group({ requests: 2, failedRequests: 0, attempts: 2 }), 'zh-CN')).toEqual({ value: '2 次', failed: '', note: '' })
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

describe('a new role and Dreaming', () => {
  it('starts without it, so the person turns it on', () => {
    const payload = { state: 'ok', revision: 'r', roles: [], connections: {}, operations: { assistant: ['project_candidate', 'dreaming'] } } as unknown as ModelRolesPayload
    expect(roleDraft(payload, 'assistant').operations).toBe('project_candidate')
  })
})
