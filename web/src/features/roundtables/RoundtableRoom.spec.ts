import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import RoundtableRoom from './RoundtableRoom.vue'
import type { RoundtableChatPage } from './roundtable-api'

const room: RoundtableChatPage = {
  chatId: 'room', kind: 'group', title: 'Room', transport: 'local', createdAt: '', updatedAt: '',
  members: [
    { address: 'local:lead', agentId: 'agent-lead', name: 'Aster', joinedSeq: 0 },
    { address: 'local:bole', agentId: 'employee.bole', name: 'Bole', joinedSeq: 0 },
    { address: 'remote:unknown', agentId: null, name: 'Unknown', joinedSeq: 0 },
  ],
  messages: ['local:lead', 'local:bole', 'remote:unknown', 'gone'].map((from, seq) => ({
    messageId: String(seq), seq, from, body: 'Hello', createdAt: '',
  })),
  nextAfter: 4, hasMore: false,
}

describe('Roundtable portraits', () => {
  it('shares known Agent images between seats and messages, retaining text for unknown senders', async () => {
    const wrapper = mount(RoundtableRoom, { props: { room, time: () => '' } })
    const expected = ['agent-lead', 'employee.bole'].map(agentAvatarUrl)
    expect(wrapper.findAll('.roundtable-seat-face img').map(image => image.attributes('src'))).toEqual(expected)
    expect(wrapper.findAll('.roundtable-chat-avatar img').map(image => image.attributes('src'))).toEqual(expected)
    const avatars = wrapper.findAll('.roundtable-chat-avatar')
    expect(avatars[2]!.find('img').exists()).toBe(false)
    expect(avatars[2]!.text()).toBe('U')
    expect(avatars[3]!.find('img').exists()).toBe(false)
    await wrapper.setProps({ room: { ...room, members: room.members.map(member => ({ ...member, name: 'Renamed' })) } })
    expect(wrapper.findAll('.roundtable-chat-avatar img').map(image => image.attributes('src'))).toEqual(expected)
    wrapper.unmount()
  })
})
