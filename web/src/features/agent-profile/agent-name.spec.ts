import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import { isGeneratedAgentName, shownAgentName } from './agent-name'
import { agentDisplayName } from './profile-model'

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('FLA names FULI wrote by itself', () => {
  it('shows the lead of an unnamed project in the console\'s words', () => {
    expect(shownAgentName('会话项目 / Conversation project 负责人')).toBe('临时项目的助手')
    expect(shownAgentName('#ab12ab12 负责人')).toBe('临时项目 #ab12ab12 的助手')
    setLocale('en-US', { persist: false })
    expect(shownAgentName('临时会话 / Temporary session 负责人')).toBe('Temporary project assistant')
    expect(shownAgentName('#ab12ab12 负责人')).toBe('Assistant for temporary project #ab12ab12')
  })

  it('never shows an internal work-kind code; the occupation when known', () => {
    expect(shownAgentName('code_review Agent')).toBe('专项助手')
    expect(shownAgentName('implementation_and_verification Agent', '开发')).toBe('开发助手')
    setLocale('en-US', { persist: false })
    expect(shownAgentName('code_review Agent', 'Developer')).toBe('Developer assistant')
  })

  it('leaves every name a person gave as written', () => {
    for (const name of ['Nova', 'Synthetic garden 负责人', 'Code Review Agent', 'Synthetic Agent']) {
      expect(isGeneratedAgentName(name)).toBe(false)
      expect(shownAgentName(name)).toBe(name)
    }
  })

  it('prefers the given name, unless FULI wrote that too', () => {
    expect(agentDisplayName({ profile: { displayName: 'Nova', name: 'code_review Agent' } })).toBe('Nova')
    expect(agentDisplayName({ profile: { displayName: 'code_review Agent', name: 'code_review Agent' } })).toBe('专项助手')
    expect(agentDisplayName({ profile: { displayName: null, name: 'Synthetic reviewer' } })).toBe('Synthetic reviewer')
  })
})
