import MarkdownIt from 'markdown-it'

// Text people and Agents write (an Agent's reply ends with a FULI receipt link)
// as Markdown. Raw HTML stays text, images stay text (no request leaves the
// console to show one), and only web, mail and fuli:// links become links; any
// other destination is shown as written. A fuli:// link (older receipts) names
// a console page by its path, so it opens inside the console; web links open
// in a new tab.
const SAFE_LINK = /^(?:https?:|mailto:|fuli:)/i
const FULI_LINK = /^fuli:\/\//i
const WEB_LINK = /^https?:/i

export type MarkdownEnv = {
  /** The href of a console path, e.g. with the router's base. */
  consoleHref?: (path: string) => string
}

const markdown = new MarkdownIt('default', { html: false, linkify: false, breaks: true, typographer: false })
markdown.disable('image')
markdown.validateLink = url => SAFE_LINK.test(url)
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!
  const href = String(token.attrGet('href') ?? '')
  if (FULI_LINK.test(href)) {
    // Never `//host`: a console path cannot become a link to another site.
    const path = `/${href.replace(FULI_LINK, '').replace(/^\/+/, '')}`
    token.attrSet('href', (env as MarkdownEnv | undefined)?.consoleHref?.(path) ?? path)
    token.attrSet('data-console-path', path)
  } else if (WEB_LINK.test(href)) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return self.renderToken(tokens, index, options)
}

/** Sanitized HTML for one Markdown text. */
export const renderMarkdown = (source: string, env: MarkdownEnv = {}) => markdown.render(source, env)
