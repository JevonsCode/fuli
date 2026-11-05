import { describe, expect, it } from 'vitest'

import { messages } from '@/i18n'
import type { ModelRolesPayload } from './model'
import { modelsInUse, taskState, useGuideUrl } from './model-uses'

// Synthetic settings only.
const connection = (id: string, model: string) => ({ id, protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', model, secretRef: null })
const payload = (roles: unknown[]): ModelRolesPayload => ({ state: 'ok', error: null, revision: null, connections: {}, roles, operations: {} } as ModelRolesPayload)

describe('model uses', () => {
  it('list each connection once, in role order, with the roles on it and Astro\'s allowed tasks', () => {
    const models = modelsInUse(payload([
      { role: 'assistant', state: 'enabled', answeredBy: 'model_api', connection: connection('small', 'synthetic-small'), allowedOperations: ['dreaming'] },
      { role: 'bole', state: 'not_configured', answeredBy: 'current_session' },
      { role: 'jefa', state: 'enabled', answeredBy: 'model_api', connection: connection('small', 'synthetic-small') },
      { role: 'tonborg', state: 'disabled', answeredBy: 'current_session', connection: connection('strong', 'synthetic-strong') },
    ]))
    expect(models.map(model => [model.id, model.model, model.uses])).toEqual([
      ['small', 'synthetic-small', [{ use: 'assistant', on: true }, { use: 'dreaming', on: true }, { use: 'jefa', on: true }]],
      ['strong', 'synthetic-strong', [{ use: 'tonborg', on: false }]],
    ])
    expect(models[0]!.service).toBe('OpenAI 兼容 · 127.0.0.1:11434')
    const semantic = modelsInUse(payload([{ role: 'semantic', state: 'enabled', answeredBy: 'model_api',
      connection: { ...connection('semantic', 'synthetic-embed'), protocol: 'openai_embeddings' } }]))
    expect(semantic[0]!.service).toBe('OpenAI 兼容向量接口 · 127.0.0.1:11434')
  })

  it('turn an Astro task on only while Astro\'s model is on and allows it', () => {
    const astro = (state: string, allowedOperations?: string[]) => payload([{ role: 'assistant', state, answeredBy: null, allowedOperations }])
    expect(taskState(astro('enabled', ['dreaming']), 'dreaming')).toBe('enabled')
    expect(taskState(astro('enabled', []), 'dreaming')).toBe('disabled')
    expect(taskState(astro('disabled', ['dreaming']), 'dreaming')).toBe('disabled')
    expect(taskState(astro('not_configured'), 'retrieval_terms')).toBe('not_configured')
    expect(taskState(astro('invalid_config'), 'retrieval_terms')).toBe('invalid_config')
    expect(taskState(payload([]), 'dreaming')).toBe('not_configured')
  })

  it('link each use to its section of the website guide', () => {
    expect(useGuideUrl('semantic', 'en-US')).toBe('https://xn--8ovp9s.xn--m8txu.com/fuli/models/en/#semantic-search')
    expect(useGuideUrl('retrieval_terms', 'zh-CN')).toBe('https://xn--8ovp9s.xn--m8txu.com/fuli/models/zh/#astro')
  })

  it('keep every recommendation and card line short in both languages', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const { uses, models } = messages[locale].modelSettings
      const lines = [...Object.values(uses.advice), ...Object.values(uses.taskStates), ...Object.values(models),
        uses.title, uses.details, uses.connect, uses.noModel, uses.noModelSemantic, uses.waiting]
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(100)
      expect(Object.keys(uses.advice).sort()).toEqual(['assistant', 'bole', 'dreaming', 'jefa', 'retrieval_terms', 'semantic', 'tonborg'])
    }
  })
})
