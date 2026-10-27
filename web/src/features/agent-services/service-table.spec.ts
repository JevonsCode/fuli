import { describe, expect, it } from 'vitest'
import type { AgentService } from './agent-services'
import { readServiceTableQuery, serviceOwners, serviceTableLocationQuery, visibleServices } from './service-table'
import { logDetailText } from './service-labels'

const service = (overrides: Partial<AgentService> = {}): AgentService => ({
  serviceId: 'svc-1', kind: 'agent_service', personalSpaceId: 'space-1', agentId: 'fla-a', projectId: 'project-a',
  client: 'claude_code', sessionId: 'session-1', appId: null, address: 'http://localhost:5173', purpose: 'Docs preview',
  command: 'npm run dev', pid: 4100, executable: null, commandLine: null, state: 'running', startedAt: '2026-10-27T08:00:00Z',
  stoppedAt: null, stopReason: null, live: { state: 'running', process: 'alive', port: 'open' }, ...overrides,
})

const names = { agent: (id: string | null) => ({ 'fla-a': 'Builder', 'fla-b': 'Reviewer' } as Record<string, string>)[id ?? ''] ?? '',
  project: (id: string | null) => ({ 'project-a': 'Alpha', 'project-b': 'Beta' } as Record<string, string>)[id ?? ''] ?? '' }

const rows = [
  service(),
  service({ serviceId: 'svc-2', agentId: 'fla-b', projectId: 'project-b', purpose: 'API server', address: '127.0.0.1:8080',
    command: 'python -m http.server', pid: 4200, startedAt: '2026-10-27T09:00:00Z', live: { state: 'stopped', process: 'gone', port: 'closed' } }),
  service({ serviceId: 'svc-3', kind: 'workbench', projectId: null, appId: 'app-1', client: 'fuli', purpose: 'Dispatch log: tracks dispatches',
    address: null, command: 'node service/main.js', pid: 4300, startedAt: '2026-10-27T07:00:00Z', live: { state: 'unknown', process: 'unverified', port: 'not_checked' } }),
]
const ids = (list: AgentService[]) => list.map(item => item.serviceId)
const query = (raw: Record<string, string> = {}) => readServiceTableQuery(raw)

describe('services table', () => {
  it('filters by FLA, project, kind and live state, and keeps running services first', () => {
    expect(ids(visibleServices(rows, query(), names, 'zh-CN'))).toEqual(['svc-1', 'svc-2', 'svc-3'])
    expect(ids(visibleServices(rows, query({ agent: 'fla-b' }), names, 'zh-CN'))).toEqual(['svc-2'])
    expect(ids(visibleServices(rows, query({ project: 'project-a' }), names, 'zh-CN'))).toEqual(['svc-1'])
    expect(ids(visibleServices(rows, query({ kind: 'workbench' }), names, 'zh-CN'))).toEqual(['svc-3'])
    expect(ids(visibleServices(rows, query({ state: 'stopped' }), names, 'zh-CN'))).toEqual(['svc-2'])
  })

  it('searches purpose, address, command, PID and the FLA and project names', () => {
    const search = (q: string) => ids(visibleServices(rows, query({ q }), names, 'en-US'))
    expect(search('python')).toEqual(['svc-2'])
    expect(search('8080')).toEqual(['svc-2'])
    expect(search('4100')).toEqual(['svc-1'])
    expect(search('reviewer')).toEqual(['svc-2'])
    expect(search('alpha')).toEqual(['svc-1'])
    expect(search('dispatch')).toEqual(['svc-3'])
    expect(search('nothing-like-this')).toEqual([])
  })

  it('keeps filters in the URL beside unrelated keys and falls back on unknown values', () => {
    expect(serviceTableLocationQuery({ item: 'x', q: 'old' }, { search: ' api ', agent: 'fla-a', project: 'all', kind: 'workbench', state: 'all' }))
      .toEqual({ item: 'x', q: 'api', agent: 'fla-a', kind: 'workbench' })
    expect(query({ kind: 'nonsense', state: 'gone' })).toEqual({ search: '', agent: 'all', project: 'all', kind: 'all', state: 'all' })
  })

  it('offers each FLA and project the records name once', () => {
    expect(serviceOwners(rows)).toEqual({ agents: ['fla-a', 'fla-b'], projects: ['project-a', 'project-b'] })
  })

  it('shows what a log entry recorded without its output', () => {
    expect(logDetailText({ id: 1, at: '2026-10-27T08:00:00Z', action: 'registered', actor: 'agent',
      detail: { agentId: 'fla-a', projectId: null, pid: 4100, changed: [] } })).toBe('agentId: fla-a · pid: 4100')
    expect(logDetailText({ id: 2, at: '2026-10-27T08:00:00Z', action: 'output', actor: 'fuli', detail: { text: 'ready' } })).toBe('')
  })
})
