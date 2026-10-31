import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { saveAgentLook, scaleAvatarImage } = vi.hoisted(() => ({ saveAgentLook: vi.fn(), scaleAvatarImage: vi.fn() }))
vi.mock('./agent-looks', async (original) => ({ ...(await original<typeof import('./agent-looks')>()), saveAgentLook }))
vi.mock('./avatar-image', async (original) => ({ ...(await original<typeof import('./avatar-image')>()), scaleAvatarImage }))

const { default: AgentAvatarPicker } = await import('./AgentAvatarPicker.vue')
const { agentLooks, forgetAgentLooks } = await import('./agent-looks')
const { generatedAvatarUrl } = await import('./agent-avatar')

afterEach(() => { forgetAgentLooks(); saveAgentLook.mockReset(); scaleAvatarImage.mockReset(); document.body.innerHTML = '' })

const panel = () => document.querySelector<HTMLElement>('[data-agent-look-panel]')
const click = async (selector: string) => {
  document.querySelector<HTMLElement>(selector)!.click()
  await flushPromises()
}

async function openPicker() {
  const wrapper = mount(AgentAvatarPicker, { props: { agentId: 'agent-synthetic', spaceId: 'space-a', name: 'Iris Vale' }, attachTo: document.body })
  await wrapper.get('[data-agent-look-trigger]').trigger('click')
  await flushPromises()
  return wrapper
}

describe('AgentAvatarPicker', () => {
  it('re-rolls with a preview first and saves the drawing only on 用这个', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')
    saveAgentLook.mockResolvedValue(undefined)
    await openPicker()
    expect(panel()?.getAttribute('aria-label')).toBe('Iris Vale 的头像')
    expect(document.querySelector('[data-agent-look-reset]')).toBeNull()
    await click('[data-agent-look-reroll]')
    expect(panel()?.textContent).toContain('还没保存')
    expect(document.querySelector('.agent-look-preview img')?.getAttribute('src')).toBe(generatedAvatarUrl('00000000-0000-4000-8000-000000000001'))
    expect(saveAgentLook).not.toHaveBeenCalled()
    await click('[data-agent-look-use]')
    expect(saveAgentLook).toHaveBeenCalledWith('space-a', 'agent-synthetic', { kind: 'generated', seed: '00000000-0000-4000-8000-000000000001' })
    expect(panel()).toBeNull()
  })

  it('previews an uploaded picture, scaled down, before saving it', async () => {
    scaleAvatarImage.mockResolvedValue('QUFB')
    saveAgentLook.mockResolvedValue(undefined)
    await openPicker()
    const input = document.querySelector<HTMLInputElement>('[data-agent-look-file]')!
    expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif')
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'face.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(document.querySelector('.agent-look-preview img')?.getAttribute('src')).toBe('data:image/webp;base64,QUFB')
    await click('[data-agent-look-use]')
    expect(saveAgentLook).toHaveBeenCalledWith('space-a', 'agent-synthetic', { kind: 'image', data: 'QUFB' })
  })

  it('offers 恢复默认 only for a changed look, and says why a save failed', async () => {
    agentLooks.value = new Map([['agent-synthetic', { agentId: 'agent-synthetic', kind: 'generated', seed: 's', updatedAt: '2026-11-01T00:00:00Z' }]])
    saveAgentLook.mockRejectedValue(new Error('offline'))
    await openPicker()
    await click('[data-agent-look-reset]')
    expect(saveAgentLook).toHaveBeenCalledWith('space-a', 'agent-synthetic', { kind: 'default' })
    expect(document.querySelector('[data-agent-look-panel] [role="alert"]')?.textContent).toBe('头像没有保存：offline')
  })
})
