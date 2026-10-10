import { messages } from './translations.js';

export const SITE_URL = 'https://xn--8ovp9s.xn--m8txu.com/fuli/';

export function structuredData(locale, pageUrl) {
  const copy = messages[locale];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': SITE_URL + '#software',
        name: 'FULI',
        alternateName: ['Fuli', '复利', 'fuli-context'],
        description: copy['meta.description'],
        url: SITE_URL,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux, Windows',
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        downloadUrl: 'https://www.npmjs.com/package/fuli-context',
        sameAs: ['https://github.com/JevonsCode/fuli', 'https://www.npmjs.com/package/fuli-context'],
        image: SITE_URL + 'assets/fuli-logo.png',
        featureList: ['agents', 'handoff', 'roundtable', 'taste', 'memory', 'database'].map(key => copy[key + '.description']),
      },
      {
        '@type': 'WebSite',
        '@id': SITE_URL + '#website',
        name: 'FULI',
        url: SITE_URL,
        inLanguage: ['zh-CN', 'en'],
        about: { '@id': SITE_URL + '#software' },
      },
      {
        '@type': 'WebPage',
        '@id': pageUrl + '#page',
        url: pageUrl,
        name: copy['meta.title'],
        description: copy['meta.description'],
        inLanguage: locale,
        isPartOf: { '@id': SITE_URL + '#website' },
        about: { '@id': SITE_URL + '#software' },
      },
    ],
  };
}
