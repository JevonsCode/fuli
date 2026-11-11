import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectOrganizing from './ProjectOrganizing.vue'
import { readProjectOrganizing, type ProjectOrganizingState } from './project-organizing'

vi.mock('./project-organizing', async importOriginal => ({ ...await importOriginal<typeof import('./project-organizing')>(),
  readProjectOrganizing: vi.fn() }))

// Synthetic coverage; nothing is read from a real project.
const AREAS = ['purpose', 'stack', 'run'].map(id => ({ id, zh: `合成 ${id}`, en: `Synthetic ${id}`, status: 'missing' }))
const state = (extra: Partial<ProjectOrganizingState> = {}): ProjectOrganizingState => ({ started: false, areas: AREAS,
  progress: { settled: 0, total: 9, complete: false }, runs: [], ...extra })

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() })
const mountCard = async () => {
  const wrapper = mount(ProjectOrganizing, { props: { spaceId: 'synthetic-space', projectId: 'synthetic-project' }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('ProjectOrganizing', () => {
  const writeText = vi.fn()
  beforeEach(() => {
    vi.mocked(readProjectOrganizing).mockReset()
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  it('says a project was never organised and copies the one sentence that starts it', async () => {
    vi.mocked(readProjectOrganizing).mockResolvedValue(state())
    const wrapper = await mountCard()
    expect(readProjectOrganizing).toHaveBeenCalledWith('synthetic-space', 'synthetic-project', expect.anything())
    expect(wrapper.get('[data-organizing-progress]').text()).toBe('还没整理过')
    expect(wrapper.get('[data-organizing-line]').text()).toContain('对你的 AI 说这句话')
    // Nothing to show yet, so no details button takes room beside the action.
    expect(wrapper.find('[data-organizing-details]').exists()).toBe(false)
    await wrapper.get('[data-organizing-copy]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('#FLA Astro 整理当前项目')
    expect(wrapper.get('[data-organizing-copy]').text()).toBe('已复制')
    expect(wrapper.get('[data-organizing-line]').text()).toBe('粘贴到你的 AI 对话里发送，整理就开始了。')
  })

  it('shows how much is known and what the last run did; the areas open in 查看详情', async () => {
    vi.mocked(readProjectOrganizing).mockResolvedValue(state({ started: true,
      areas: [{ ...AREAS[0]!, status: 'known' }, { ...AREAS[1]!, status: 'unsure' }, AREAS[2]!],
      progress: { settled: 7, total: 9, complete: false },
      runs: [{ at: '2026-11-11T09:00:00.000Z', model: 'synthetic-opus', tier: 'strong', added: 12, merged: 2, stale: 1, unsure: 3 }] }))
    const wrapper = await mountCard()
    expect(wrapper.get('[data-organizing-progress]').text()).toBe('已了解 7 / 9')
    expect(wrapper.get('[data-organizing-line]').text()).toContain('新增 12、合并 2、过时 1、待你看 3')
    await wrapper.get('[data-organizing-details]').trigger('click')
    const dialog = wrapper.get('[data-organizing-dialog]')
    expect(dialog.get('[data-organizing-area="purpose"]').text()).toContain('已了解')
    expect(dialog.get('[data-organizing-area="stack"]').text()).toContain('待确认')
    expect(dialog.get('[data-organizing-area="run"]').text()).toContain('还缺')
    expect(dialog.get('[data-organizing-runs]').text()).toContain('synthetic-opus · 强')
  })

  it('says when the state cannot be read or the sentence cannot be copied, and still offers the sentence', async () => {
    vi.mocked(readProjectOrganizing).mockRejectedValue(new Error('synthetic failure'))
    writeText.mockRejectedValue(new Error('synthetic clipboard failure'))
    const wrapper = await mountCard()
    expect(wrapper.get('[data-organizing-progress]').text()).toBe('暂时读不到')
    await wrapper.get('[data-organizing-copy]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-organizing-line]').text()).toBe('没有复制成功，请手动输入：#FLA Astro 整理当前项目')
  })
})
