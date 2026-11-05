// The public website's guide pages (site/<page>/), in the console's language:
// the quick start (guide) and the model guide (models).
const WEBSITE = 'https://xn--8ovp9s.xn--m8txu.com/fuli/'

export type WebsitePage = 'guide' | 'models'

export const websitePageUrl = (page: WebsitePage, locale: string) => `${WEBSITE}${page}/${locale.startsWith('zh') ? 'zh/' : 'en/'}`
