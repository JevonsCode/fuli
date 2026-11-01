import { describe, expect, it } from 'vitest'
import type { AgentService } from './agent-services'
import { readServiceSearch, serviceGroups, serviceSearchLocationQuery, visibleServices } from './service-table'
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

describe('services list', () => {
  it('lists the latest start first and groups running, unconfirmed, then stopped', () => {
    const visible = visibleServices(rows, '', names, 'zh-CN')
    expect(ids(visible)).toEqual(['svc-2', 'svc-1', 'svc-3'])
    expect(serviceGroups(visible).map(group => [group.key, ids(group.rows)]))
      .toEqual([['running', ['svc-1']], ['unknown', ['svc-3']], ['stopped', ['svc-2']]])
    expect(serviceGroups(rows.filter(service => service.serviceId === 'svc-2')).map(group => group.key)).toEqual(['stopped'])
  })

  it('searches purpose, address, command, PID and the FLA and project names', () => {
    const search = (q: string) => ids(visibleServices(rows, q, names, 'en-US'))
    expect(search('python')).toEqual(['svc-2'])
    expect(search('8080')).toEqual(['svc-2'])
    expect(search('4100')).toEqual(['svc-1'])
    expect(search('reviewer')).toEqual(['svc-2'])
    expect(search('alpha')).toEqual(['svc-1'])
    expect(search('dispatch')).toEqual(['svc-3'])
    expect(search('nothing-like-this')).toEqual([])
  })

  it('keeps the search in the URL beside unrelated keys', () => {
    expect(serviceSearchLocationQuery({ item: 'x', q: 'old' }, ' api ')).toEqual({ item: 'x', q: 'api' })
    expect(serviceSearchLocationQuery({ item: 'x', q: 'old' }, ' ')).toEqual({ item: 'x' })
    expect(readServiceSearch({ q: ['', 'docs'] })).toBe('docs')
  })

  it('shows what a log entry recorded without its output', () => {
    expect(logDetailText({ id: 1, at: '2026-10-27T08:00:00Z', action: 'registered', actor: 'agent',
      detail: { agentId: 'fla-a', projectId: null, pid: 4100, changed: [] } })).toBe('agentId: fla-a · pid: 4100')
    expect(logDetailText({ id: 2, at: '2026-10-27T08:00:00Z', action: 'output', actor: 'fuli', detail: { text: 'ready' } })).toBe('')
  })
})
