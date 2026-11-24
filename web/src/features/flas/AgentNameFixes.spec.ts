import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson, postJson }))

const { default: AgentNameFixes } = await import('./AgentNameFixes.vue')

// A synthetic plan as the console answers GET /api/project-agent-name-fixes.
// 'Station Backup' stands for a temporary project: it stores no name.
const project = (name: string) => name === 'Station Backup'
  ? { projectId: `temporary-${'c0'.repeat(32)}`, name: '', scopeType: 'temporary' }
  : { projectId: `p-${name}`, name, scopeType: 'registered' }
const member = (agentId: string, name: string, projectName: string, keeps: boolean, newName: string | null = null,
  gaveWay: string | null = null) => ({ agentId, name, status: 'active', projects: [project(projectName)], keeps, newName, gaveWay })
const PLAN = { renames: 2, groups: [
  { name: 'Morgan Vale', members: [member('morgan-a', 'Morgan Vale', 'Saturn', true),
    member('morgan-b', 'Morgan Vale', 'Station Backup', false, 'Nora Hill', 'less_recent')] },
  { name: 'Casey Hayes', members: [member('casey-a', 'Casey Hayes', 'Saturn', true),
    member('casey-b', 'Casey Hayes', 'Saturn', false, 'Theo Park', 'later')] },
] }
const SWAPPED = { renames: 2, groups: [
  { name: 'Morgan Vale', members: [member('morgan-b', 'Morgan Vale', 'Station Backup', true),
    member('morgan-a', 'Morgan Vale', 'Saturn', false, 'Iris Reed', 'person_chose')] }, PLAN.groups[1]!] }

async function show() {
  const wrapper = mount(AgentNameFixes, { props: { personalSpaceId: 'space-a' }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

afterEach(() => { getJson.mockReset(); postJson.mockReset(); document.body.innerHTML = '' })

describe('AgentNameFixes', () => {
  it('says how many names are shared and lists who keeps each, what the others become and why', async () => {
    getJson.mockResolvedValue(PLAN)
    const wrapper = await show()
    expect(wrapper.get('[data-flas-name-fixes] p').text()).toBe('有 2 个名字不止一位 FLA 在用。')
    await wrapper.get('[data-flas-name-fixes-open]').trigger('click')
    await flushPromises()
    const rows = [...document.querySelectorAll('[data-name-fix-member]')].map(row => row.textContent?.replace(/\s+/g, ' ').trim())
    expect(rows[0]).toBe('Morgan Vale · 在任 · Saturn保留名字')
    // A temporary project reads as everywhere else in the console, by its number.
    expect(rows[1]).toContain('Morgan Vale · 在任 · 临时项目 #c0c0c0c0改为 Nora Hill Morgan Vale 最近更活跃')
    expect(document.querySelector('[data-name-fix-apply]')?.textContent?.trim()).toBe('全部处理（2 位改名）')
  })

  it('says each FLA\'s status, and offers no other keeper where a built-in role keeps the name', async () => {
    getJson.mockResolvedValue({ renames: 2, groups: [
      { name: 'Bole', members: [member('employee.bole', 'Bole', 'Saturn', true),
        { ...member('bole-fla', 'Bole', 'Saturn', false, 'Nova Park', 'built_in_role'), status: 'archived' }] },
      { name: 'Casey Hayes', members: [member('casey-a', 'Casey Hayes', 'Saturn', true),
        { ...member('casey-b', 'Casey Hayes', 'Saturn', false, 'Theo Park', 'dismissed'), status: 'archived' }] }] })
    const wrapper = await show()
    await wrapper.get('[data-flas-name-fixes-open]').trigger('click')
    await flushPromises()
    const status = (agentId: string) => document.querySelector(`[data-name-fix-member="${agentId}"] [data-name-fix-status]`)?.textContent
    expect([status('casey-a'), status('casey-b')]).toEqual([' · 在任', ' · 已离任'])
    expect(document.querySelector('[data-name-fix-member="bole-fla"] [data-name-fix-keep]')).toBeNull()
    expect(document.querySelector('[data-name-fix-member="casey-b"] [data-name-fix-keep]')).not.toBeNull()
  })

  it('leaves a rename out, lets another keep a name, and renames the rest in one apply', async () => {
    getJson.mockResolvedValueOnce(PLAN).mockResolvedValueOnce(SWAPPED)
    postJson.mockResolvedValue({ renames: 0, groups: [] })
    const wrapper = await show()
    await wrapper.get('[data-flas-name-fixes-open]').trigger('click')
    await flushPromises()
    ;(document.querySelector('[data-name-fix-member="morgan-b"] [data-name-fix-keep]') as HTMLButtonElement).click()
    await flushPromises()
    expect(getJson.mock.calls[1]![0]).toBe('/api/project-agent-name-fixes?personalSpaceId=space-a&keep=morgan-b')
    ;(document.querySelector('[data-name-fix-member="casey-b"] [data-name-fix-rename]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-name-fix-apply]')?.textContent?.trim()).toBe('全部处理（1 位改名）')
    ;(document.querySelector('[data-name-fix-apply]') as HTMLButtonElement).click()
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/project-agent-name-fixes/apply',
      { personalSpaceId: 'space-a', keep: ['morgan-b'], renames: { 'morgan-a': 'Iris Reed' } }, expect.anything())
    expect(wrapper.emitted('settled')).toHaveLength(1)
    expect(wrapper.find('[data-flas-name-fixes]').exists()).toBe(false)
  })

  it('reads the list again when FLAs changed meanwhile, and shows nothing without shared names', async () => {
    getJson.mockResolvedValue(PLAN)
    postJson.mockRejectedValue(new ApiError('409', 409, JSON.stringify({ code: 'agent_name_fixes_changed', error: 'changed' })))
    const wrapper = await show()
    await wrapper.get('[data-flas-name-fixes-open]').trigger('click')
    await flushPromises()
    ;(document.querySelector('[data-name-fix-apply]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('FLA 有变化，已重新读取，请再看一遍。')
    expect(getJson).toHaveBeenCalledTimes(2)
    getJson.mockResolvedValue({ renames: 0, groups: [] })
    expect((await show()).find('[data-flas-name-fixes]').exists()).toBe(false)
  })
})
