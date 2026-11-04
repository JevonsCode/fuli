import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { useConsoleStore } from '@/stores/console'
import StorageSettings from './StorageSettings.vue'

// Synthetic answers of GET /api/old-data (src/old-data/port.js).
const MB = 1024 * 1024
const FORMAT_BACKUP = {
  id: 'format_backup:format-backups/judgment.sqlite.v1-2026-11-01T08-00-00-000Z.sqlite', kind: 'format_backup',
  path: 'format-backups/judgment.sqlite.v1-2026-11-01T08-00-00-000Z.sqlite',
  left: { zh: '升级数据格式前的 judgment.sqlite（v1→v2）', en: 'judgment.sqlite before its data format went from v1 to v2' },
  createdAt: '2026-11-01T08:00:00.000Z', bytes: 2 * MB, restorable: true, restoreCommand: null,
}
const OLD_LOG = {
  id: 'log_archive:logs/runtime.log', kind: 'log_archive', path: 'logs/runtime.log',
  left: { zh: '日志超过 50 MB 后留下的旧 runtime.log', en: 'Older runtime.log kept after it passed 50 MB' },
  createdAt: '2026-10-20T00:00:00.000Z', bytes: 50 * MB, restorable: false, restoreCommand: null,
}
const withOld = (items = [FORMAT_BACKUP, OLD_LOG]) => ({ items,
  summary: { liveBytes: 1024 * MB, oldBytes: items.reduce((sum, item) => sum + item.bytes, 0), totalBytes: 1100 * MB } })

afterEach(() => vi.unstubAllGlobals())

function mountCard(answers: unknown[]) {
  const reads = [...answers]
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/restore')) return Response.json({ id: FORMAT_BACKUP.id, restore: { status: 'stopping' } })
    if (init?.method === 'POST' && url.endsWith('/delete')) return Response.json({ id: OLD_LOG.id, freedBytes: OLD_LOG.bytes })
    return Response.json(reads.length > 1 ? reads.shift() : reads[0])
  })
  vi.stubGlobal('fetch', fetch)
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(StorageSettings, { attachTo: document.body, global: { plugins: [pinia] } })
  return { fetch, wrapper, store: useConsoleStore() }
}

it('shows only the live size and no list when there is no old data', async () => {
  const { wrapper } = mountCard([{ items: [], summary: { liveBytes: 1024 * MB, oldBytes: 0, totalBytes: 1024 * MB } }])
  expect(wrapper.text()).toContain('正在读取存储用量')
  await flushPromises()
  expect(wrapper.get('[data-storage-headline]').text()).toBe('数据 1 GB')
  expect(wrapper.find('[data-old-data-open]').exists()).toBe(false)
  wrapper.unmount()
})

it('lists old data, restores at once and deletes after a second click in place', async () => {
  const { fetch, wrapper, store } = mountCard([withOld(), withOld([FORMAT_BACKUP])])
  await flushPromises()
  expect(wrapper.get('[data-storage-headline]').text()).toBe('数据 1 GB · 旧数据 52 MB')
  await wrapper.get('[data-old-data-open]').trigger('click')
  await flushPromises()
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-old-data-item]')]
  expect(rows().map(row => row.querySelector('strong')?.textContent)).toEqual([FORMAT_BACKUP.left.zh, OLD_LOG.left.zh])
  // Only a format backup has a restore in the console.
  expect(rows().map(row => Boolean(row.querySelector('[data-old-data-restore]')))).toEqual([true, false])

  rows()[0].querySelector<HTMLButtonElement>('[data-old-data-restore]')!.click()
  await flushPromises()
  expect(fetch).toHaveBeenCalledWith(`/api/old-data/${encodeURIComponent(FORMAT_BACKUP.id)}/restore`, expect.objectContaining({ method: 'POST' }))
  expect(store.feedback?.message).toBe(`正在恢复「${FORMAT_BACKUP.left.zh}」，FULI 会重启一下`)

  const remove = () => rows()[1].querySelector<HTMLButtonElement>('[data-old-data-delete]')!
  remove().click()
  await flushPromises()
  expect(remove().textContent?.trim()).toBe('确认删除')
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/delete'))).toEqual([])
  remove().click()
  await flushPromises()
  expect(fetch).toHaveBeenCalledWith(`/api/old-data/${encodeURIComponent(OLD_LOG.id)}/delete`, expect.objectContaining({ method: 'POST' }))
  expect(store.feedback?.message).toBe(`已删除「${OLD_LOG.left.zh}」，释放 50 MB`)
  expect(rows().map(row => row.dataset.oldDataItem)).toEqual([FORMAT_BACKUP.id])
  expect(wrapper.get('[data-storage-headline]').text()).toBe('数据 1 GB · 旧数据 2 MB')
  wrapper.unmount()
})
