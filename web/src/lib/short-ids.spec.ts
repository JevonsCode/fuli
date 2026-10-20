import { describe, expect, it } from 'vitest'

import { shortUniqueIds } from './short-ids'

describe('shortUniqueIds', () => {
  it('keeps short ids whole and never cuts on a separator', () => {
    const ids = ['t-bench-1', 'task-ru-000123-final', 'b7c8d9e0-1111-4222-8333-444455556666']
    expect([...shortUniqueIds(ids).values()]).toEqual(['t-bench-1', 'task-ru', 'b7c8d9e0'])
  })

  it('grows to 12 characters, then the whole id, where ids in the list share a prefix', () => {
    const ids = ['3f1a2b3c-aaaa-1', '3f1a2b3c-bbbb-1', '3f1a2b3c-aaaa-4bbb-8ccc-1', '3f1a2b3c-aaaa-4bbb-8ccc-2']
    expect([...shortUniqueIds(ids).values()]).toEqual(['3f1a2b3c-aaaa-1', '3f1a2b3c-bbb', '3f1a2b3c-aaaa-4bbb-8ccc-1', '3f1a2b3c-aaaa-4bbb-8ccc-2'])
  })
})
