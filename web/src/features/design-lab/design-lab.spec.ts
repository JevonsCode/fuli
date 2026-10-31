import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

describe('workbench preference', () => {
  it('reads the workbench from an older lab preference and persists changes', async () => {
    localStorage.setItem('fuli.lab', JSON.stringify({ workbench: 'office', open: true, transition: 'rise' }))
    const { designLab } = await import('./design-lab')
    expect(designLab.value).toEqual({ workbench: 'office' })

    designLab.value.workbench = 'board'
    await nextTick()
    expect(JSON.parse(localStorage.getItem('fuli.lab')!)).toEqual({ workbench: 'board' })
  })

  it.each(['null', '{', '{"workbench":42}', '{}'])('defaults when the stored preference is %s', async stored => {
    localStorage.setItem('fuli.lab', stored)
    const { designLab } = await import('./design-lab')
    expect(designLab.value.workbench).toBe('current')
  })
})
