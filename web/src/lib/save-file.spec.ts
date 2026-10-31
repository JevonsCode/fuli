import { afterEach, describe, expect, it, vi } from 'vitest'

import { DESKTOP_SAVE_HANDLER, saveFile } from './save-file'

type Bridged = { flutter_inappwebview?: { callHandler: (...args: unknown[]) => Promise<unknown> } }

afterEach(() => {
  delete (window as Bridged).flutter_inappwebview
  vi.restoreAllMocks()
})

describe('saveFile', () => {
  it('asks the desktop client to save and resolves with where it saved', async () => {
    const callHandler = vi.fn(async () => ({ saved: true, path: 'C:\\Users\\synthetic\\Downloads\\export.json' }))
    ;(window as Bridged).flutter_inappwebview = { callHandler }
    const create = vi.spyOn(URL, 'createObjectURL')
    await expect(saveFile('export.json', '{"a":1}', 'application/json')).resolves.toBe('C:\\Users\\synthetic\\Downloads\\export.json')
    expect(callHandler).toHaveBeenCalledWith(DESKTOP_SAVE_HANDLER, { name: 'export.json', content: '{"a":1}', type: 'application/json' })
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects when the desktop client could not save, so nothing that depends on it goes ahead', async () => {
    ;(window as Bridged).flutter_inappwebview = { callHandler: async () => ({ saved: false, error: 'disk full' }) }
    await expect(saveFile('export.json', '{}', 'application/json')).rejects.toThrow('disk full')
    ;(window as Bridged).flutter_inappwebview = { callHandler: async () => undefined }
    await expect(saveFile('export.json', '{}', 'application/json')).rejects.toThrow(/could not save/)
  })

  it('is an ordinary download in a browser', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let downloaded = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloaded = this.download })
    await expect(saveFile('notes.md', '# Notes', 'text/markdown')).resolves.toBeNull()
    expect(create).toHaveBeenCalledOnce()
    expect(downloaded).toBe('notes.md')
  })
})
