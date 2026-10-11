import { describe, expect, it, vi } from 'vitest'
import { waitForSettingsApply } from './settings-apply'
import type { SystemSettingsResult } from '@/types'

const operation = { id: 'test-operation', status: 'applying' as const, port: 2727 }
const signal = () => new AbortController().signal
const result = (status: string, rest = {}) => ({ apply: { ...operation, status, ...rest }, restartRequired: status !== 'applied' }) as SystemSettingsResult

describe('settings application reconnect', () => {
  it('waits through a disconnected service and requires the matching operation to finish', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...result('applied'), apply: { ...operation, id: 'older-operation', status: 'applied' } })
      .mockResolvedValueOnce(result('applying')).mockResolvedValueOnce(result('applied'))
    const completed = await waitForSettingsApply(operation, signal(), { origin: 'http://127.0.0.1:2727', read, wait: async () => {} })
    expect(completed.settings?.apply?.status).toBe('applied')
    expect(read).toHaveBeenCalledTimes(4)
  })
  it('only redirects to the new port after its readiness image loads', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const completed = await waitForSettingsApply({ ...operation, port: 3030 }, signal(), {
      origin: 'http://127.0.0.1:2727', read: async () => { throw new Error('offline') }, probe, wait: async () => {},
    })
    expect(completed.url).toBe('http://127.0.0.1:3030/settings?settingsApplied=test-operation')
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe.mock.calls[0]?.[0]).toContain('/api/system/settings/ready.svg?id=test-operation')
  })
  it('reports a failed application and its confirmed rollback', async () => {
    await expect(waitForSettingsApply(operation, signal(), { origin: 'http://127.0.0.1:2727',
      read: async () => result('failed', { rolledBack: true, error: 'Port unavailable' }),
    })).rejects.toThrow('已恢复原设置')
  })
  it('stops when the page leaves and never claims success after a timeout', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(waitForSettingsApply(operation, controller.signal)).rejects.toThrow()
    await expect(waitForSettingsApply(operation, signal(), { timeout: 0 })).rejects.toThrow('无法确认')
  })
})
