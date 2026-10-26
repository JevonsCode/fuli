import { describe, expect, it } from 'vitest'

// The console never sends the person to a terminal (owner's rule,
// 2026-10-26/27): every step is a button, or, when FULI does it by itself, a
// plain statement of what happens. This scans every zh-CN and en-US console
// message for a FULI command, a shell instruction or the word terminal.
const COMMAND = new RegExp([
  String.raw`\b(?:fuli|fl) (?:start|stop|restart|status|open|clients|connect|connect-workspace|mcp|setup|peer|remote-mcp|employee|app|models|session|worker|update|uninstall|migrate|graph)\b`,
  String.raw`终端`,
  String.raw`\b[Ii]n (?:a|the|your) terminal\b`,
  String.raw`\bnpm (?:install|i|update|run)\b`,
  String.raw`\bchmod\b`,
  String.raw`\bUpdate-Fuli\b`,
].join('|'))

// Each entry names one message and why it may keep a command. Keep it empty
// unless the text documents the CLI itself and is never shown as a step.
const ALLOWED = new Map<string, string>([
  // The employee recruit dialog is being rebuilt without an install step on
  // JVS/jefa-builtin-board, which deletes these two messages; remove these
  // entries when that branch lands.
  ['employees.ts:zh-CN.installHelp', 'removed by JVS/jefa-builtin-board'],
  ['employees.ts:en-US.installHelp', 'removed by JVS/jefa-builtin-board'],
])

const files = import.meta.glob<Record<string, unknown>>('./messages/*.ts', { eager: true })

function* strings(value: unknown, path: string[]): Generator<[string, string]> {
  if (typeof value === 'string') yield [path.join('.'), value]
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) yield* strings(child, [...path, key])
  }
}

function offenders() {
  const found: string[] = []
  for (const [file, module] of Object.entries(files)) {
    const name = file.replace('./messages/', '')
    for (const exported of Object.values(module)) {
      for (const [key, text] of strings(exported, [])) {
        const id = `${name}:${key}`
        if (COMMAND.test(text) && !ALLOWED.has(id)) found.push(`${id} = ${text}`)
      }
    }
  }
  return found
}

describe('console messages', () => {
  it('scans the zh-CN and en-US message files', () => {
    expect(Object.keys(files).length).toBeGreaterThan(20)
    const keys = Object.values(files).flatMap(module => Object.values(module))
      .flatMap(exported => [...strings(exported, [])].map(([key]) => key))
    expect(keys.some(key => key.startsWith('zh-CN.'))).toBe(true)
    expect(keys.some(key => key.startsWith('en-US.'))).toBe(true)
  })

  it('never tell the person to run a command in a terminal', () => {
    expect(offenders()).toEqual([])
  })

  it('catches the instructions it is meant to catch', () => {
    for (const text of ['运行 fuli migrate reconcile-knowledge', 'Run fuli setup to update it.', '在终端运行：',
      'Stop FULI, then run fuli migrate restore in a terminal.', 'then run fl employee install <directory>.']) {
      expect(COMMAND.test(text), text).toBe(true)
    }
    for (const text of ['Merge the fuli entry into your client’s MCP settings', '粘贴 fuli-peer-invite:1:…', '终态']) {
      expect(COMMAND.test(text), text).toBe(false)
    }
  })
})
