import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { setMotionPreference } from '@/lib/motion-preference'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

const { default: AgentAvatar } = await import('./AgentAvatar.vue')
const { agentAvatarUrl, defaultAvatarUrl, generatedAvatarUrl } = await import('./agent-avatar')
const { agentLooks, forgetAgentLooks } = await import('./agent-looks')
const { loadRemoteFaces, memberFaceId, remoteAvatarUrl, remoteFaces } = await import('./remote-faces')

// Synthetic: two paired computers, as the asking computer's GET /api/roundtable/agents lists them.
const DEVICE = '7fc6a1b2c3d4e5f6'
const ROLLED = `peer:${DEVICE}:binding-rolled`
const PLAIN = `peer:${DEVICE}:binding-plain`
const PICTURE = `peer:${DEVICE}:binding-picture`
const OLD = `peer:${DEVICE}:binding-old`
const remoteAgents = [
  { address: ROLLED, agentId: 'agent-milo', name: 'Milo Reed', device: { name: 'FULI 7FC6', online: true }, look: { kind: 'generated', seed: 'seed-milo-3' } },
  { address: PLAIN, agentId: 'agent-ivy', name: 'Ivy Moss', device: { name: 'FULI 7FC6', online: true } },
  // A computer that one day sends a picture look: drawn by default until pictures cross.
  { address: PICTURE, agentId: 'agent-pia', name: 'Pia Lune', device: { name: 'FULI 7FC6', online: true }, look: { kind: 'image', imageVersion: 'abc' } },
  // An older computer's entry: no look and no device field.
  { address: OLD, agentId: 'agent-oak', name: 'Oak Hale' },
]

afterEach(() => { forgetAgentLooks(); remoteFaces.value = new Map(); getJson.mockReset() })

async function loaded() {
  getJson.mockResolvedValue({ agents: [], remoteAgents })
  await loadRemoteFaces()
}

async function face(props: Record<string, unknown>, wrap = (child: ReturnType<typeof h>) => h('span', { class: 'frame' }, [child])) {
  const wrapper = mount(defineComponent({ render: () => wrap(h(AgentAvatar, props as { agentId: string })) }), { attachTo: document.body })
  await nextTick()
  return wrapper
}

describe('faces of FLAs on another computer', () => {
  it('draws the same picture the home computer draws, by default and after a re-roll', async () => {
    await loaded()
    // What the owner's computer draws for its own Agent: no look → default from its id; re-rolled → that seed.
    expect(remoteAvatarUrl(PLAIN)).toBe(defaultAvatarUrl('agent-ivy'))
    expect(remoteAvatarUrl(ROLLED)).toBe(generatedAvatarUrl('seed-milo-3'))
    expect(remoteAvatarUrl(ROLLED)).not.toBe(defaultAvatarUrl(ROLLED))
    // A sender asking from that computer is named by its agentId: same face.
    expect(remoteAvatarUrl(`peer:${DEVICE}:agent-milo`)).toBe(generatedAvatarUrl('seed-milo-3'))
  })

  it('an uploaded picture there falls back to the default drawing here; an old entry still draws', async () => {
    await loaded()
    expect(remoteAvatarUrl(PICTURE)).toBe(defaultAvatarUrl('agent-pia'))
    expect(remoteAvatarUrl(OLD)).toBe(defaultAvatarUrl('agent-oak'))
    const wrapper = await face({ agentId: OLD, name: 'Oak Hale' })
    expect(wrapper.get('img').attributes('src')).toBe(defaultAvatarUrl('agent-oak'))
    expect(wrapper.get('img').attributes('title')).toBe('Oak Hale（另一台电脑）')
    wrapper.unmount()
  })

  it('an unknown sender address is drawn from the agentId it ends with', () => {
    expect(remoteAvatarUrl(`peer:${DEVICE}:agent-elsewhere`)).toBe(defaultAvatarUrl('agent-elsewhere'))
  })

  it('never changes or reads a local Agent face, even with the same agentId', async () => {
    agentLooks.value = new Map([['agent-milo', { agentId: 'agent-milo', kind: 'generated', seed: 'local-seed', updatedAt: '2026-11-01T00:00:00Z' }]])
    const before = agentAvatarUrl('agent-milo')
    await loaded()
    expect(agentAvatarUrl('agent-milo')).toBe(before)
    expect(agentAvatarUrl('agent-ivy')).toBe(defaultAvatarUrl('agent-ivy'))
    expect([...agentLooks.value.keys()]).toEqual(['agent-milo'])
    expect(remoteAvatarUrl(ROLLED)).toBe(generatedAvatarUrl('seed-milo-3'))
  })

  it('a coordinator that cannot be reached keeps the faces known so far', async () => {
    await loaded()
    getJson.mockResolvedValue({ agents: [], remoteAgents: [], remoteUnavailable: 'coordinator_unreachable' })
    await loadRemoteFaces()
    expect(remoteAvatarUrl(ROLLED)).toBe(generatedAvatarUrl('seed-milo-3'))
  })

  it('a chat member is drawn by its address only when it lives on another computer', async () => {
    await loaded()
    expect(memberFaceId({ address: ROLLED, agentId: 'agent-milo' })).toBe(ROLLED)
    expect(memberFaceId({ address: 'local:agent-own', agentId: 'agent-own' })).toBe('agent-own')
    expect(memberFaceId({ address: 'peer:0000000000000000:binding-own', agentId: 'agent-own' })).toBe('agent-own')
  })

  it('carries the ring and the computer in its name, and is never a local link or portrait menu', async () => {
    await loaded()
    const wrapper = await face({ agentId: ROLLED, name: 'Milo Reed' }, child => h('div', [child]))
    const img = wrapper.get('img')
    expect(img.attributes('data-agent-remote')).toBe('framed')
    expect(img.attributes('alt')).toBe('Milo Reed · FULI 7FC6（另一台电脑）')
    expect(img.attributes('title')).toBe('Milo Reed · FULI 7FC6（另一台电脑）')
    for (const name of ['data-agent-portrait', 'data-agent-link', 'role', 'tabindex']) expect(img.attributes(name)).toBeUndefined()
    wrapper.unmount()
  })

  it('does not repeat a computer the name already ends with, and keeps the label short', async () => {
    await loaded()
    const sender = await face({ agentId: `peer:${DEVICE}:agent-milo`, name: 'Milo Reed · FULI 7FC6' })
    expect(sender.get('img').attributes('title')).toBe('Milo Reed · FULI 7FC6（另一台电脑）')
    const long = await face({ agentId: PLAIN, name: 'N'.repeat(140) })
    expect(long.get('img').attributes('title')!.length).toBeLessThanOrEqual(100)
    for (const wrapper of [sender, long]) wrapper.unmount()
  })

  it('a local face has no ring and no computer in its name', async () => {
    await loaded()
    const wrapper = await face({ agentId: 'agent-milo', name: 'Milo Reed' }, child => h('div', [child]))
    const img = wrapper.get('img')
    expect(img.attributes('data-agent-remote')).toBeUndefined()
    expect(img.attributes('title')).toBeUndefined()
    expect(img.attributes('data-agent-portrait')).toBe('agent-milo')
    wrapper.unmount()
  })

  it('a face too small for dashes gets the plain ring', async () => {
    await loaded()
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 13, height: 13 } as DOMRect)
    try {
      const small = await face({ agentId: ROLLED })
      expect(small.get('img').attributes('data-agent-remote')).toBe('compact')
      small.unmount()
      rect.mockReturnValue({ width: 24, height: 24 } as DOMRect)
      const row = await face({ agentId: ROLLED })
      expect(row.get('img').attributes('data-agent-remote')).toBe('framed')
      row.unmount()
    } finally { rect.mockRestore() }
  })

  it('reduced motion stills a remote face exactly as it stills the same face at home', async () => {
    await loaded()
    setMotionPreference('reduced')
    try {
      expect(remoteAvatarUrl(ROLLED)).toBe(generatedAvatarUrl('seed-milo-3'))
      expect(remoteAvatarUrl(PLAIN)).toBe(defaultAvatarUrl('agent-ivy'))
      expect(decodeURIComponent(remoteAvatarUrl(PLAIN))).not.toContain('@keyframes')
    } finally { setMotionPreference('system') }
  })
})
