import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import { fixPrompt, ISSUES_URL, redactForPrompt } from './fix-prompt'

// Synthetic paths and addresses only.
beforeEach(() => setLocale('zh-CN', { persist: false }))

describe('the prompt copied for the person\'s AI', () => {
  it('hides home paths, emails, URL queries and long secrets', () => {
    const text = redactForPrompt(String.raw`C:\Users\someone\AppData\x.json` + ' /home/someone/.fuli/a /Users/someone/b '
      + 'mail tester@example.org http://127.0.0.1:2828/api/x?token=abc '
      + 'key ' + 'a1'.repeat(24))
    expect(text).toBe(String.raw`~\AppData\x.json` + ' ~/.fuli/a ~/b mail … http://127.0.0.1:2828/api/x key …')
  })

  it('says what, where and the error, then asks to look for a known issue first and to ask before opening one', () => {
    const prompt = fixPrompt({ what: '本机服务还没准备好', error: 'Unexpected token \'<\' at C:/Users/someone/x', page: '/', version: '9.9.9-synthetic', serviceReady: false })
    expect(prompt).toContain('现象：本机服务还没准备好')
    expect(prompt).toContain('页面：/')
    expect(prompt).toContain('错误信息：Unexpected token \'<\' at ~/x')
    expect(prompt).toContain('FULI 版本：9.9.9-synthetic')
    expect(prompt).toContain('本机服务：未就绪')
    expect(prompt).toContain(ISSUES_URL)
    expect(prompt.indexOf(ISSUES_URL)).toBeLessThan(prompt.indexOf('好修的'))
    expect(prompt).toContain('先问我愿不愿意在 GitHub 上提一个 issue')
  })

  it('leaves out what it does not know', () => {
    const prompt = fixPrompt({ what: 'x', page: '/a' })
    expect(prompt).not.toContain('错误信息')
    expect(prompt).not.toContain('本机服务：')
  })
})
