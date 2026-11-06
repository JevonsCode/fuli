import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskRetrospective from './TaskRetrospective.vue'

// fuli#346: a finished task's view shows Astro's retrospective and links its pending lessons.
function respond(retrospective: unknown) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ retrospective }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return urls
}

const written = { at: '2026-11-06T10:00:00Z', status: 'written', summary: 'Synthetic summary.', problems: ['Synthetic slow review'],
  lessons: [{ title: 'Synthetic lesson', status: 'queued' }, { title: 'Synthetic other', status: 'failed' }], wordsRemoved: false }
const render = (active: boolean) => mount(TaskRetrospective, { props: { taskId: 'task a', active }, global: { stubs: { RouterLink: RouterLinkStub } } })

afterEach(() => { vi.unstubAllGlobals() })

describe('a task retrospective', () => {
  it('reads only once the details open, then shows what was done, what went wrong and the lessons', async () => {
    const urls = respond(written)
    const wrapper = render(false)
    await flushPromises()
    expect(urls).toEqual([])
    await wrapper.setProps({ active: true })
    await flushPromises()
    expect(urls).toEqual(['/api/retrospectives?taskId=task+a'])
    const section = wrapper.get('[data-task-retrospective]')
    expect(section.text()).toContain('Synthetic summary.')
    expect(section.text()).toContain('Synthetic slow review')
    expect(section.text()).toContain('Synthetic lesson')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/inbox')
    expect(wrapper.get('[data-retrospective-confirm]').text()).toBe('去确认 1 条经验')
  })

  it('says nothing before one is written or when an attempt failed', async () => {
    respond(null)
    expect((await mountRead()).find('[data-task-retrospective]').exists()).toBe(false)
    respond({ ...written, status: 'model_failed' })
    expect((await mountRead()).find('[data-task-retrospective]').exists()).toBe(false)
  })

  it('has no confirm link when nothing waits, and says when a delete took the words', async () => {
    respond({ ...written, lessons: [], wordsRemoved: true, summary: null, problems: [] })
    const wrapper = await mountRead()
    expect(wrapper.find('[data-retrospective-confirm]').exists()).toBe(false)
    expect(wrapper.text()).toContain('永久删除')
  })
})

async function mountRead() {
  const wrapper = render(true)
  await flushPromises()
  return wrapper
}
