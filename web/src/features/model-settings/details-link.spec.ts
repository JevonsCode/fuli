import { describe, expect, it } from 'vitest'

import { linkedModelDetails, modelDetailsLink } from './details-link'

describe('a link into a use\'s details', () => {
  it('names the use and the part, and reads back only what the page has', () => {
    expect(modelDetailsLink('tonborg', 'delegation')).toEqual({ path: '/models', query: { details: 'tonborg' }, hash: '#delegation' })
    expect(linkedModelDetails({ details: 'tonborg' }, '#delegation')).toEqual({ role: 'tonborg', part: 'delegation' })
    expect(linkedModelDetails({ details: 'tonborg' }, '#elsewhere')).toEqual({ role: 'tonborg', part: null })
    expect(linkedModelDetails({ details: 'nobody' }, '#delegation')).toBeNull()
    expect(linkedModelDetails({}, '')).toBeNull()
  })
})
