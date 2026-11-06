import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { dismissalBlock, dismissalRefusal, lessonLines, lessonsFit, textFits } from './bole-dismissal'

describe('Bole dismissal rules in the console', () => {
  it('counts a text the way the tool does: trimmed, in characters, 4 to 1000', () => {
    expect(textFits('  没跑 ')).toBe(false)
    expect(textFits('没跑测试')).toBe(true)
    expect(textFits('😀😀😀😀')).toBe(true)
    expect(textFits('字'.repeat(1000))).toBe(true)
    expect(textFits('字'.repeat(1001))).toBe(false)
  })

  it('reads one lesson per line, up to three', () => {
    expect(lessonLines(' 先跑测试 \n\n   \n写清结果')).toEqual(['先跑测试', '写清结果'])
    expect(lessonsFit([])).toBe(true)
    expect(lessonsFit(['先跑测试', '写清结果', '提前说明'])).toBe(true)
    expect(lessonsFit(['先跑测试', '写清结果', '提前说明', '再加一条'])).toBe(false)
    expect(lessonsFit(['太短'])).toBe(false)
  })

  it('blocks a built-in role first, then open work, then leading a project', () => {
    const agent = { id: 'agent.a', hasOpenTask: false, leadsProject: false }
    expect(dismissalBlock(agent)).toBeNull()
    expect(dismissalBlock({ ...agent, leadsProject: true })).toBe('project_lead')
    expect(dismissalBlock({ ...agent, hasOpenTask: true, leadsProject: true })).toBe('open_tasks')
    for (const id of ['employee.jefa', 'employee.bole', 'employee.tonborg', 'employee.assistant']) {
      expect(dismissalBlock({ ...agent, id })).toBe('built_in')
    }
  })

  it('answers a refusal in the person\'s language', () => {
    expect(dismissalRefusal(new ApiError('Ask the user why', 400))).toContain('真实原因')
    expect(dismissalRefusal(new ApiError('value_error', 422))).toContain('真实原因')
    expect(dismissalRefusal(new ApiError('Agent leads a project', 409))).toContain('现在不能开除')
    expect(dismissalRefusal(new Error('network down'))).toBe('network down')
  })
})
