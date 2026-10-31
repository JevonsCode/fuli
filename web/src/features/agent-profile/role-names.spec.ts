import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { setLocale, t } from '@/i18n'
import { messages } from '@/i18n'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson, putJson }))

const { builtInRole, forgetRoleNames, loadRoleNames, roleName } = await import('./role-names')
const { renameAgent } = await import('./agent-rename')
const { employeeName } = await import('@/features/employees/catalog')
const { roleName: modelRoleName } = await import('@/features/model-settings/model')

const record = (agentId: string, name: string, displayName: string | null) => ({
  agentId, personalSpaceId: 'space-a', profile: { name, displayName, status: 'active', capabilities: [] },
})

afterEach(() => { forgetRoleNames(); setLocale('zh-CN', { persist: false }); getJson.mockReset(); putJson.mockReset() })

// Every message string that names a built-in role, with its locale.
function namingMessages(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return /(?<![A-Za-z])(Jefa|Bole|Tonborg|Astro)(?![A-Za-z])/.test(value) ? [path] : []
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => namingMessages(child, path ? `${path}.${key}` : key))
}

describe('built-in role names', () => {
  it('names each role only through roleNames, never as a literal word in copy', () => {
    const offenders = (['zh-CN', 'en-US'] as const).flatMap(locale => namingMessages(messages[locale]).map(path => `${locale}: ${path}`))
    expect(offenders.filter(path => !path.includes(': roleNames.'))).toEqual([])
  })

  it('reads each role’s current name once per space and shows it in every label', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.includes('employee.bole')) return record('employee.bole', 'Bole', '伯乐')
      if (url.includes('employee.jefa')) return record('employee.jefa', 'Jefa', null)
      throw new ApiError('Not found', 404)
    })
    await loadRoleNames('space-a')
    await loadRoleNames('space-a')
    expect(getJson).toHaveBeenCalledTimes(4)
    expect(roleName('bole')).toBe('伯乐')
    expect(roleName('jefa')).toBe('Jefa')
    expect(roleName('tonborg')).toBe('Tonborg')
    expect(t('projectAgents.emptyCopy')).toContain('伯乐')
    expect(employeeName({ id: 'bole', name: 'Bole' })).toBe('伯乐')
    expect(employeeName({ id: 'custom', name: 'Custom helper' })).toBe('Custom helper')
    setLocale('en-US', { persist: false })
    expect(t('projectAgents.emptyCopy')).toBe('Start a project task and 伯乐 will staff an Agent.')
  })

  it('a rename shows at once; restoring the role’s name brings the original back', async () => {
    putJson.mockResolvedValueOnce(record('employee.assistant', 'Astro', 'Nova'))
    await renameAgent({ personalSpaceId: 'space-a', agentId: 'employee.assistant' }, 'Nova')
    expect(roleName('astro')).toBe('Nova')
    expect(modelRoleName('assistant')).toBe('Nova')
    putJson.mockResolvedValueOnce(record('employee.assistant', 'Astro', null))
    await renameAgent({ personalSpaceId: 'space-a', agentId: 'employee.assistant' }, null)
    expect(roleName('astro')).toBe('Astro')
    // Any other Agent's rename leaves the roles alone.
    putJson.mockResolvedValueOnce(record('agent-synthetic', 'Iris', 'Mira'))
    await renameAgent({ personalSpaceId: 'space-a', agentId: 'agent-synthetic' }, 'Mira')
    expect(builtInRole('agent-synthetic')).toBeNull()
    expect(roleName('astro')).toBe('Astro')
  })
})
