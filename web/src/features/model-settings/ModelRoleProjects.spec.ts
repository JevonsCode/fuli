import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, putJson: api.putJson, postJson: api.postJson,
}))

import { setLocale } from '@/i18n'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import type { PersonalProject } from '@/types'
import ModelRoleDialog from './ModelRoleDialog.vue'
import type { ApprovedProject, ModelRolesPayload } from './model'

// Which projects Astro's model may receive: 2 named projects and 12 unnamed temporary
// ones, all synthetic. Saving sends the list; reopening reads back what was saved.
const REVISION = 'd'.repeat(64)
const BUDGET = { maxInputTokens: null, maxOutputTokens: null, timeoutMs: null, windowHours: null, maxTokensPerWindow: null, maxCostPerWindow: null }
const formal = ['alpha', 'beta'].map((id): PersonalProject => ({ project_id: id, personal_space_id: 'space-1', profile: { name: `Synthetic ${id}` } }))
const temporary = Array.from({ length: 12 }, (_, index): PersonalProject => ({
  project_id: `temporary-${index.toString(16).repeat(64).slice(0, 64)}`, personal_space_id: 'space-1', scope_type: 'temporary',
  profile: { name: '临时会话 / Temporary session' }, updated_at: `2026-11-${String(index + 1).padStart(2, '0')}T08:00:00Z`,
}))
const projects = [...formal, ...temporary]
const asApproved = (project: PersonalProject): ApprovedProject => ({ personalSpaceId: project.personal_space_id, personalProjectId: project.project_id })

function payload(egress?: { approvedProjects: ApprovedProject[]; allowUnassigned: boolean }): ModelRolesPayload {
  return {
    state: 'ok', error: null, revision: REVISION, operations: {},
    connections: egress ? { assistant: { protocol: 'openai_chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'synthetic', secretRef: null, reasoningEffort: null, pricing: null } } : {},
    roles: [egress
      ? { role: 'assistant', state: 'enabled', answeredBy: 'model_api', connection: { id: 'assistant', protocol: 'openai_chat', endpointHost: '127.0.0.1:11434', model: 'synthetic', secretRef: null },
          allowedOperations: [], egress, budget: BUDGET, fallbackToSession: false }
      : { role: 'assistant', state: 'not_configured', answeredBy: 'current_session' }],
  } as ModelRolesPayload
}

const mounted: VueWrapper[] = []
beforeEach(() => {
  api.postJson.mockResolvedValue({ models: [] })
  api.putJson.mockImplementation(async (_url: string, body: { settings: { egress: unknown } }) => payload(body.settings.egress as never))
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  setLocale('zh-CN', { persist: false })
  vi.clearAllMocks()
})

function open(rolePayload: ModelRolesPayload, props: { projects?: PersonalProject[]; projectsLoaded?: boolean } = {}) {
  const wrapper = mount(ModelRoleDialog, { attachTo: document.body,
    props: { role: 'assistant', payload: rolePayload, projects: props.projects ?? projects, projectsLoaded: props.projectsLoaded ?? true },
    global: { stubs: { OptionSelect: optionSelectStubs.OptionSelect } } })
  mounted.push(wrapper)
  return wrapper
}
const group = (wrapper: VueWrapper) => wrapper.get('[data-project-scope-temporary]')
const count = (wrapper: VueWrapper) => wrapper.get('[data-project-scope-temporary-count]').text()
const box = (wrapper: VueWrapper, project: PersonalProject) =>
  wrapper.get(`[id="model-role-project-${project.personal_space_id}/${project.project_id}"]`)
async function save(wrapper: VueWrapper) {
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  return api.putJson.mock.calls.at(-1)![1].settings.egress as { approvedProjects: ApprovedProject[]; allowUnassigned: boolean }
}

describe('the projects Astro may send to its model', () => {
  it('first open: two named rows and one folded 临时项目 12/12; unticking two saves and reopens as 10/12, also in English', async () => {
    const first = open(payload())
    expect(first.findAll('[data-project-scope-formal]').map(row => row.text())).toEqual(['Synthetic alpha', 'Synthetic beta'])
    expect(group(first).text()).toContain('临时项目')
    expect(count(first)).toBe('12/12')
    expect(first.find('[data-project-scope-temporary-list]').exists()).toBe(false)
    await first.get('#model-role-enabled').trigger('click')
    await first.get('[data-project-scope-temporary-toggle]').trigger('click')
    await box(first, temporary[3]!).trigger('click')
    await box(first, temporary[7]!).trigger('click')
    expect(count(first)).toBe('10/12')
    expect(first.get(`[id="model-role-project-temporary"]`).attributes('data-state')).toBe('indeterminate')
    const saved = await save(first)
    expect(saved.approvedProjects).toHaveLength(12)
    expect(saved.approvedProjects).not.toContainEqual(asApproved(temporary[3]!))
    expect(saved.allowUnassigned).toBe(false)

    const again = open(payload(saved))
    expect(count(again)).toBe('10/12')
    setLocale('en-US', { persist: false })
    await flushPromises()
    expect(group(again).text()).toContain('Temporary projects')
    expect(count(again)).toBe('10/12')
    await again.get('[data-project-scope-temporary-toggle]').trigger('click')
    expect(box(again, temporary[3]!).attributes('data-state')).toBe('unchecked')
    expect(box(again, temporary[7]!).attributes('data-state')).toBe('unchecked')
  })

  it('clearing the group saves none of them and reopens as 0/12; named projects and 不属于项目的内容 stay as chosen', async () => {
    const wrapper = open(payload({ approvedProjects: projects.map(asApproved), allowUnassigned: true }))
    await wrapper.get('[id="model-role-project-temporary"]').trigger('click')
    expect(count(wrapper)).toBe('0/12')
    const saved = await save(wrapper)
    expect(saved.approvedProjects).toEqual(formal.map(asApproved))
    expect(saved.allowUnassigned).toBe(true)
    expect(count(open(payload(saved)))).toBe('0/12')
  })

  it('shows a saved empty list as nothing chosen, and never adds a project that appeared after saving', async () => {
    const empty = open(payload({ approvedProjects: [], allowUnassigned: false }))
    expect(count(empty)).toBe('0/12')
    expect(box(empty, formal[0]!).attributes('data-state')).toBe('unchecked')
    const subset = open(payload({ approvedProjects: [asApproved(formal[0]!)], allowUnassigned: false }), { projects })
    const added: PersonalProject = { ...temporary[0]!, project_id: `temporary-${'e'.repeat(64)}` }
    await subset.setProps({ projects: [...projects, added] })
    expect(count(subset)).toBe('0/13')
    expect((await save(subset)).approvedProjects).toEqual([asApproved(formal[0]!)])
  })

  it('waits for projects read after the form opened, follows refreshes until the person changes the list, and never saves before', async () => {
    const wrapper = open(payload(), { projects: [], projectsLoaded: false })
    expect(wrapper.find('[data-model-projects-loading]').exists()).toBe(true)
    expect(wrapper.get('[data-model-save]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(api.putJson).not.toHaveBeenCalled()

    await wrapper.setProps({ projects, projectsLoaded: true })
    expect(count(wrapper)).toBe('12/12')
    expect(box(wrapper, formal[1]!).attributes('data-state')).toBe('checked')
    const later: PersonalProject = { ...temporary[0]!, project_id: `temporary-${'f'.repeat(64)}` }
    await wrapper.setProps({ projects: [...projects, later] })
    expect(count(wrapper)).toBe('13/13')

    await wrapper.get('#model-role-enabled').trigger('click')
    await box(wrapper, formal[1]!).trigger('click')
    await wrapper.setProps({ projects: [...projects, later, { ...later, project_id: `temporary-${'c'.repeat(64)}` }] })
    expect(count(wrapper)).toBe('13/14')
    expect(box(wrapper, formal[1]!).attributes('data-state')).toBe('unchecked')
    const saved = await save(wrapper)
    expect(saved.approvedProjects).toHaveLength(14)
    expect(saved.approvedProjects).not.toContainEqual(asApproved(formal[1]!))
  })

  it('finds a temporary project by its number, opening the folded row on it', async () => {
    const wrapper = open(payload())
    await wrapper.get('[data-project-scope-search]').setValue('#55555555')
    const shown = wrapper.findAll('[data-project-scope-temporary-item]')
    expect(shown).toHaveLength(1)
    expect(shown[0]!.text()).toContain('#55555555')
    expect(wrapper.findAll('[data-project-scope-formal]')).toHaveLength(0)
  })
})
