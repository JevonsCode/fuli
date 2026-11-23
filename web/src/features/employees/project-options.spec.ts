import { describe, expect, it } from 'vitest'

import { projectSelectOptions } from './project-options'

describe('projectSelectOptions', () => {
  it('shows the project ID only where two projects share a name', () => {
    expect(projectSelectOptions([
      { id: 'alpha', name: '同名项目' },
      { id: 'beta', name: '同名项目' },
      { id: 'gamma', name: 'Gamma' },
    ])).toEqual([
      { value: 'alpha', label: '同名项目', meta: 'alpha' },
      { value: 'beta', label: '同名项目', meta: 'beta' },
      { value: 'gamma', label: 'Gamma' },
    ])
  })

  it('lists named projects first in their order, temporary ones after under the folding heading', () => {
    const options = projectSelectOptions([
      { id: 'temporary-a', name: '临时项目 #aaaaaaaa', temporary: true },
      { id: 'beta', name: 'Synthetic beta' },
      { id: 'alpha', name: 'Synthetic alpha', temporary: false },
    ])
    expect(options.map(option => option.value)).toEqual(['beta', 'alpha', 'temporary-a'])
    expect(options[2]).toMatchObject({ group: '临时项目', search: 'temporary-a' })
    expect(options[0]).not.toHaveProperty('group')
  })
})
