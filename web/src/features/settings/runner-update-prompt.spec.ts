import { describe, expect, it } from 'vitest'

import { runnerUpdatePrompt } from './runner-update-prompt'

describe('the prompt that updates an older runner (rec issue 144)', () => {
  it('names the host\'s exact version and the commands, never "or newer"', () => {
    const zh = runnerUpdatePrompt('v0.29.0', 'zh-CN')!
    expect(zh).toContain('npm install --global fuli-context@0.29.0')
    expect(zh).toContain('fuli restart')
    expect(zh).toContain('fuli runner status')
    expect(zh).not.toContain('或更新')
    const en = runnerUpdatePrompt('0.29.0-beta.10', 'en-US')!
    expect(en).toContain('npm install --global fuli-context@0.29.0-beta.10')
    expect(en).toContain('exactly 0.29.0-beta.10')
    expect(en).not.toMatch(/or newer\)/)
  })

  it('gives no prompt for something that is not a plain version', () => {
    expect(runnerUpdatePrompt('0.29.0; rm -rf ~', 'zh-CN')).toBeNull()
    expect(runnerUpdatePrompt('', 'en-US')).toBeNull()
  })
})
