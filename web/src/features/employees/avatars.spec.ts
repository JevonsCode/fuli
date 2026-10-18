import { describe, expect, it } from 'vitest'
import { employeeAvatarUrl } from './avatars'

describe('built-in employee avatars', () => {
  it('gives every built-in employee, including Astro the assistant, a portrait', () => {
    for (const id of ['jefa', 'bole', 'tonborg', 'assistant', 'employee.assistant']) {
      expect(employeeAvatarUrl(id), id).toBeTruthy()
    }
    expect(employeeAvatarUrl('custom-agent')).toBeUndefined()
  })
})