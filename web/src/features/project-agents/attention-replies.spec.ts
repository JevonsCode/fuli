import { describe, expect, it } from 'vitest'
import { attentionAnswerLength, attentionReplies, composeAttentionReply } from './attention-replies'

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
    expect(composeAttentionReply('', '', choices)).toBeNull()
    expect(composeAttentionReply('other', '  ', choices)).toBeNull()
    expect(composeAttentionReply('other', '  改为两列  ', choices)).toEqual({ choice: null, note: '改为两列' })
    const answer = composeAttentionReply('accept', '补充意见', choices)!
    expect(answer).toEqual({ choice: choices[0]!.value, note: '补充意见' })
    expect(attentionAnswerLength(answer)).toBe(`${choices[0]!.value}\n\n补充意见`.length)
  })
  it('offers Done for a hand step and keeps the Agent’s own choices first', () => {
    expect(attentionReplies({ kind: 'permission', requestedAction: '请运行 gh auth login 登录' }).map(x => x.id)).toEqual(['done', 'agree', 'decline'])
    expect(attentionReplies({ kind: 'blocked', requestedAction: '请在 Claude Code 里信任 hooks' }).map(x => x.label)).toEqual(['我已完成', '请补充信息'])
    expect(attentionReplies({ kind: 'permission', requestedAction: '选哪个？', options: ['用 A', '用 B'] }).map(x => x.value)).toEqual(['用 A', '用 B'])
  })
})
