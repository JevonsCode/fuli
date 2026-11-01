import { describe, expect, it } from 'vitest'

import type { RuntimeSettings } from '@/types'
import { pendingRestartFields, withoutRestartChanges } from './settings-restart'

const active = {
  version: 1,
  graphRuntimeMode: 'container',
  ports: { console: 2727, personalProvider: 8787, personalNeo4jHttp: 8060, personalNeo4jBolt: 7687,
    workspaceProvider: 8788, workspaceNeo4jHttp: 7475, workspaceNeo4jBolt: 7688 },
  lanAccess: false,
  resourceRefreshSeconds: 5,
  notifications: { needsPersonUrl: '' },
  agentNamingStyle: '',
  topicPromotion: 'auto',
} as unknown as RuntimeSettings

describe('settings restart', () => {
  it('keeps every restart setting as FULI runs now in what saves itself', () => {
    const form = { ...active, ports: { ...active.ports, console: 3030 }, lanAccess: true, graphRuntimeMode: 'native',
      resourceRefreshSeconds: 10 } as RuntimeSettings
    expect(withoutRestartChanges(form, active)).toEqual({ ...active, resourceRefreshSeconds: 10 })
  })

  it('names each restart setting the form changes, and none for other settings', () => {
    expect([...pendingRestartFields({ ...active, resourceRefreshSeconds: 60 } as RuntimeSettings, active)]).toEqual([])
    const form = { ...active, ports: { ...active.ports, personalNeo4jBolt: 7688 }, lanAccess: true, graphRuntimeMode: 'native' } as RuntimeSettings
    expect([...pendingRestartFields(form, active)]).toEqual(['ports', 'lanAccess', 'graphRuntimeMode'])
  })
})
