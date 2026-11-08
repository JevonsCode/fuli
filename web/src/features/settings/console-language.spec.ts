import { afterEach, describe, expect, it, vi } from 'vitest'

import { rememberConsoleLanguage } from './console-language'

const configured = { version: 1, graphRuntimeMode: 'native', lanAccess: false, ports: { console: 2727 }, consoleLanguage: '' }

function stub(stored: string, fail = false) {
  const puts: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    if (fail) return Response.json({}, { status: 503 })
    if (String(input) === '/api/system/settings' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      puts.push(body)
      return Response.json({ configured: body, active: body, restartRequired: false })
    }
    const current = { ...configured, consoleLanguage: stored }
    return Response.json({ configured: current, active: current, restartRequired: false })
  }))
  return puts
}

describe('rememberConsoleLanguage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('saves the language the console shows when FULI holds none, changing nothing else', async () => {
    const puts = stub('')
    await rememberConsoleLanguage()
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ consoleLanguage: 'zh-CN', ports: { console: 2727 }, lanAccess: false })
  })

  it('leaves a language the person picked, and a failed read, alone', async () => {
    expect(stub('en-US')).toEqual([])
    await rememberConsoleLanguage()
    const puts = stub('', true)
    await expect(rememberConsoleLanguage()).resolves.toBeUndefined()
    expect(puts).toEqual([])
  })
})
