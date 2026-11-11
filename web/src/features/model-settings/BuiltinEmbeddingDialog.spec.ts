import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BuiltinEmbeddingDialog from './BuiltinEmbeddingDialog.vue'
import {
  downloadBuiltinModel, readBuiltinModels, removeBuiltinModel, useBuiltinModel, type BuiltinModel, type BuiltinModels,
} from './builtin-embedding'
import ModelRoleCard from './ModelRoleCard.vue'
import { roleDraft, type ModelRolesPayload, type ModelRoleView } from './model'

vi.mock('./builtin-embedding', async importOriginal => ({ ...await importOriginal<typeof import('./builtin-embedding')>(),
  readBuiltinModels: vi.fn(), downloadBuiltinModel: vi.fn(), useBuiltinModel: vi.fn(), removeBuiltinModel: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(),
  getJson: vi.fn(async () => ({ model: null, total: 0, done: 0, running: false })), postJson: vi.fn() }))

// Synthetic catalog rows; nothing is downloaded.
const model = (id: string, extra: Partial<BuiltinModel> = {}): BuiltinModel => ({ id, name: `Synthetic ${id}`,
  summary: { zh: '合成模型。', en: 'Synthetic model.' }, languages: ['zh'], license: 'MIT', source: 'https://huggingface.co/synthetic/x',
  dimensions: 16, memoryMb: 200, recommended: false, downloadBytes: 96 * 1024 * 1024, installed: false, outdated: false, inUse: false,
  download: null, ...extra })
const list = (models: BuiltinModel[]): BuiltinModels => ({ inUse: models.find(item => item.inUse)?.id ?? null, models, retired: [] })

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() })
const open = async () => {
  const wrapper = mount(BuiltinEmbeddingDialog, { props: { open: true }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const row = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.get(`[data-builtin-model="${id}"]`)

describe('BuiltinEmbeddingDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const mocked of [readBuiltinModels, downloadBuiltinModel, useBuiltinModel, removeBuiltinModel]) vi.mocked(mocked).mockReset()
  })

  it('lists each model with what it costs and one action; the recommended one leads with 下载并使用', async () => {
    vi.mocked(readBuiltinModels).mockResolvedValue(list([model('a', { recommended: true }), model('b', { installed: true }),
      model('c', { installed: true, inUse: true })]))
    const wrapper = await open()
    expect(row(wrapper, 'a').text()).toContain('下载 96 MB，运行约占 200 MB 内存。')
    expect(row(wrapper, 'a').find('[data-builtin-recommended]').exists()).toBe(true)
    expect(row(wrapper, 'a').get('[data-builtin-download]').text()).toBe('下载并使用')
    expect(row(wrapper, 'b').get('[data-builtin-use]').text()).toBe('使用')
    expect(row(wrapper, 'b').get('[data-builtin-remove]').text()).toBe('删除')
    // The model in use says so and offers nothing that would take search away.
    expect(row(wrapper, 'c').get('[data-builtin-in-use]').text()).toBe('使用中')
    expect(row(wrapper, 'c').findAll('button')).toHaveLength(0)
  })

  it('shows a download as it goes, reads again each second, and tells the page when search switched', async () => {
    vi.useFakeTimers()
    vi.mocked(readBuiltinModels).mockResolvedValueOnce(list([model('a', { recommended: true })]))
    const wrapper = await open()
    vi.mocked(downloadBuiltinModel).mockResolvedValue(list([model('a', { recommended: true,
      download: { status: 'downloading', receivedBytes: 24, totalBytes: 96, reason: null } })]))
    await row(wrapper, 'a').get('[data-builtin-download]').trigger('click')
    await flushPromises()
    expect(downloadBuiltinModel).toHaveBeenCalledWith('a')
    expect(row(wrapper, 'a').get('[data-builtin-downloading]').text()).toContain('正在下载 Synthetic a：25%')
    expect(wrapper.emitted('changed')).toBeUndefined()
    vi.mocked(readBuiltinModels).mockResolvedValueOnce(list([model('a', { recommended: true, installed: true, inUse: true })]))
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(row(wrapper, 'a').find('[data-builtin-in-use]').exists()).toBe(true)
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('says why a download was not kept and offers 重试', async () => {
    vi.mocked(readBuiltinModels).mockResolvedValue(list([model('a', {
      download: { status: 'failed', receivedBytes: 0, totalBytes: 96, reason: 'embedding_model_altered' } }),
    model('b', { download: { status: 'failed', receivedBytes: 0, totalBytes: 96, reason: 'embedding_model_unavailable' } })]))
    const wrapper = await open()
    expect(row(wrapper, 'a').get('[data-builtin-failed]').text()).toBe('下载的文件和目录里登记的不一致，没有保留。请重试。')
    expect(row(wrapper, 'b').get('[data-builtin-failed]').text()).toBe('没有下载成功，可能连不上 Hugging Face。请重试。')
    expect(row(wrapper, 'a').get('[data-builtin-download]').text()).toBe('重试')
  })

  it('switches to an installed model, removes one, and leads to the own-service form', async () => {
    vi.mocked(readBuiltinModels).mockResolvedValue(list([model('a', { installed: true, inUse: true }), model('b', { installed: true })]))
    const wrapper = await open()
    vi.mocked(useBuiltinModel).mockResolvedValue(list([model('a', { installed: true }), model('b', { installed: true, inUse: true })]))
    await row(wrapper, 'b').get('[data-builtin-use]').trigger('click')
    await flushPromises()
    expect(useBuiltinModel).toHaveBeenCalledWith('b')
    expect(wrapper.emitted('changed')).toHaveLength(1)
    vi.mocked(removeBuiltinModel).mockResolvedValue(list([model('a'), model('b', { installed: true, inUse: true })]))
    await row(wrapper, 'a').get('[data-builtin-remove]').trigger('click')
    await flushPromises()
    expect(removeBuiltinModel).toHaveBeenCalledWith('a')
    expect(row(wrapper, 'a').find('[data-builtin-download]').exists()).toBe(true)
    await wrapper.get('[data-builtin-own]').trigger('click')
    expect(wrapper.emitted('own')).toHaveLength(1)
  })
})

describe('语义搜索 with a built-in model', () => {
  const view = (connection?: ModelRoleView['connection']): ModelRoleView => ({ role: 'semantic', state: connection ? 'enabled' : 'not_configured',
    answeredBy: connection ? 'model_api' : null, ...(connection ? { connection, allowedOperations: ['knowledge_embedding'] } : {}) } as ModelRoleView)
  const builtin = { id: 'builtin-embedding', protocol: 'builtin_embeddings' as const, endpointHost: '127.0.0.1', model: 'bge-small-zh-v1.5', secretRef: null }

  it('offers 内置模型 first when nothing is connected, and shows a built-in model as on this computer', async () => {
    const empty = mount(ModelRoleCard, { props: { view: view(), locked: false, editing: false } })
    mounted.push(empty)
    await flushPromises()
    expect(empty.get('[data-model-role-builtin-open]').text()).toBe('内置模型')
    expect(empty.get('[data-model-role-edit]').text()).toBe('接入')
    await empty.get('[data-model-role-builtin-open]').trigger('click')
    expect(empty.emitted('builtin')).toHaveLength(1)
    const used = mount(ModelRoleCard, { props: { view: view(builtin), locked: false, editing: false } })
    mounted.push(used)
    await flushPromises()
    expect(used.get('[data-model-role-model]').text()).toBe('bge-small-zh-v1.5')
    expect(used.get('[data-model-role-builtin]').text()).toBe('本机内置')
    // A built-in model is changed in its own list, not in the address-and-key form.
    expect(used.find('[data-model-role-edit]').exists()).toBe(false)
  })

  it('starts the own-service form from an empty connection instead of the built-in one', () => {
    const payload = { state: 'ok', error: null, revision: 'r', operations: { semantic: ['knowledge_embedding'] },
      connections: { 'builtin-embedding': { protocol: 'builtin_embeddings', endpoint: 'http://127.0.0.1/builtin-embeddings', model: 'bge-small-zh-v1.5',
        secretRef: null, reasoningEffort: null, pricing: null } },
      roles: [view(builtin)] } as unknown as ModelRolesPayload
    const draft = roleDraft(payload, 'semantic')
    expect([draft.connectionId, draft.protocol, draft.endpoint, draft.model]).toEqual(['semantic', 'openai_embeddings', '', ''])
  })
})
