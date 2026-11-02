import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

const fragment = (source: string, consoleHref?: (path: string) => string) => {
  const element = document.createElement('div')
  element.innerHTML = renderMarkdown(source, consoleHref ? { consoleHref } : {})
  return element
}

describe('renderMarkdown', () => {
  it('turns a FULI receipt with an angle-bracket destination and escaped brackets into a console link', () => {
    const element = fragment('Done.\n\nFULI Agent：[Lyra North \\[fuli 负责人\\]](<fuli://agents/space-1/agent-1>)', path => `/console${path}`)
    const link = element.querySelector('a')!
    expect(link.textContent).toBe('Lyra North [fuli 负责人]')
    expect(link.getAttribute('href')).toBe('/console/agents/space-1/agent-1')
    expect(link.dataset.consolePath).toBe('/agents/space-1/agent-1')
    expect(link.getAttribute('target')).toBeNull()
    expect(element.textContent).not.toContain('](')
  })

  it('renders emphasis, inline and fenced code, lists and line breaks', () => {
    const element = fragment('**Bold** and *soft* with `code`\nnext line\n\n- one\n- two\n\n1. first\n\n```js\nconst a = "<b>"\n```')
    expect(element.querySelector('strong')!.textContent).toBe('Bold')
    expect(element.querySelector('em')!.textContent).toBe('soft')
    expect(element.querySelector('p code')!.textContent).toBe('code')
    expect(element.querySelector('p br')).not.toBeNull()
    expect([...element.querySelectorAll('ul li')].map(item => item.textContent)).toEqual(['one', 'two'])
    expect(element.querySelector('ol li')!.textContent).toBe('first')
    expect(element.querySelector('pre code')!.textContent).toBe('const a = "<b>"\n')
    expect(element.querySelector('b')).toBeNull()
  })

  it('keeps raw HTML and images as text and links only web, mail and fuli destinations', () => {
    const element = fragment('<img src=x onerror="alert(1)"> <script>alert(1)</script>\n\n'
      + '![pic](https://example.test/a.png) [bad](javascript:alert(1)) [data](data:text/html,x) [file](file:///c:/x)\n\n'
      + '[web](https://example.test/page) [mail](mailto:someone@example.test) [hop](fuli:////example.test/x)')
    expect(element.querySelector('img, script')).toBeNull()
    expect(element.textContent).toContain('<script>alert(1)</script>')
    const links = [...element.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')])
    expect(links).toEqual([
      ['pic', 'https://example.test/a.png', '_blank', 'noopener noreferrer'],
      ['web', 'https://example.test/page', '_blank', 'noopener noreferrer'],
      ['mail', 'mailto:someone@example.test', null, null],
      ['hop', '/example.test/x', null, null],
    ])
    expect(element.textContent).toContain('[bad](javascript:alert(1))')
  })
})
