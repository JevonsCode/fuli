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
})
