import { describe, expect, it } from 'vitest'
import { attentionReplies, composeAttentionReply } from './attention-replies'

describe('attention reply choices', () => {
  it('uses explicit lettered alternatives without inventing answers', () => {
    expect(attentionReplies({ kind: 'question', requestedAction: '请选择：\nA. 保留现有方案\nB. 使用新版方案' }).map(x => x.value))
      .toEqual(['A. 保留现有方案', 'B. 使用新版方案'])
  })
  it('does not mistake numbered instructions for alternatives', () => {
    expect(attentionReplies({ kind: 'question', requestedAction: '1. 打开设置\n2. 保存配置' }).map(x => x.id))
      .toEqual(['clarify'])
    expect(attentionReplies({ kind: 'question', requestedAction: '执行步骤：\nA. 打开设置\nB. 保存配置' }).map(x => x.id)).toEqual(['clarify'])
  })
  it('provides explicit review responses and never preselects them', () => {
    const choices = attentionReplies({ kind: 'review', requestedAction: '请审核变更' })
    expect(choices.map(x => x.id)).toEqual(['accept', 'revise'])
    expect(composeAttentionReply('', '', choices)).toBe('')
    expect(composeAttentionReply('other', '  改为两列  ', choices)).toBe('改为两列')
    expect(composeAttentionReply('accept', '补充意见', choices)).toBe(`${choices[0]!.value}\n\n补充意见`)
  })
})
