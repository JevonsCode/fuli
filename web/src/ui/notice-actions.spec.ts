import { describe, expect, it } from 'vitest'

// Every notice that says something is not possible, not in effect, waiting on
// the person or limited carries what to do about it (docs/console-design.md,
// 「提示要带去处」): a button, a link, or 「让 AI 来做」. A warning or error
// UiNotice therefore has an action inside it, or says on itself why it needs
// none (data-no-action="<why>"), so every exception is visible in review.
// Every tone but success is held to it (an info notice can say something is
// not possible too), and so is one whose tone is set at run time (:tone). An
// action that only shows on a condition (<template v-if #actions>) does not
// count: the notice can show without it.

const SOURCES = import.meta.glob<string>(['../**/*.vue', '!../ui/UiNotice.vue', '!../components/ui/**'],
  { query: '?raw', import: 'default', eager: true })

// Notices that still stop at the problem. Each entry is a debt, not a pass:
// fix the notice and remove its file here; the count per file may only go down.
const PENDING = new Map<string, [count: number, why: string]>([
  ['../features/project-agents/TaskRunControls.vue', [1, 'a stop or retry the person may not make: not in the 0.29.0 pass']],
  ['../features/debug-turns/IssueLogPanel.vue', [2, 'host-only report and a failed read: not in the 0.29.0 pass (model settings, Tonborg, clients, pairing, updates, 待拍板)']],
  ['../features/projects/ProjectBoardSettings.vue', [1, 'manager gone: the project team page is being reworked on JVS/workstream-flas']],
  ['../features/settings/StorageSettings.vue', [1, 'storage could not be read: not in the 0.29.0 pass']],
  ['../features/statement-calendar/StatementCalendarPage.vue', [2, 'statement could not be read: not in the 0.29.0 pass']],
  ['../pages/DataFormatPage.vue', [1, 'plan went stale: not in the 0.29.0 pass']],
  ['../pages/SharedJefaReportPage.vue', [1, 'some projects unavailable on a shared report: not in the 0.29.0 pass']],
])

const NOTICE = /<UiNotice\b(?:(?!<UiNotice\b)[\s\S])*?(?:<\/UiNotice>|\/>)/g
const SUCCESS_TONE = /(?:^|\s)tone="success"/
const ACTION = /#actions|<Button\b|<RouterLink\b|<a\s|<AiHelpButton\b/
// An #actions slot shown only on a condition, in either attribute order.
const CONDITIONAL_ACTIONS = /<template\b[^>]*\bv-(?:if|else-if|show)=[^>]*#actions[^>]*>[\s\S]*?<\/template>|<template\b[^>]*#actions[^>]*\bv-(?:if|else-if|show)=[^>]*>[\s\S]*?<\/template>/g
const OPT_OUT = /\sdata-no-action="([^"]{10,})"/

/** The warning or error notices of one source that have no action and do not say why. */
export function noticesWithoutAction(source: string): string[] {
  return [...source.matchAll(NOTICE)].map(([block]) => block).filter((block) => {
    const opening = block.slice(0, block.indexOf('>') + 1)
    return !SUCCESS_TONE.test(opening) && !ACTION.test(block.replace(CONDITIONAL_ACTIONS, '')) && !OPT_OUT.test(opening)
  })
}

function offenders() {
  const found: string[] = []
  for (const [file, source] of Object.entries(SOURCES)) {
    const blocks = noticesWithoutAction(source)
    const allowed = PENDING.get(file)?.[0] ?? 0
    if (blocks.length > allowed) found.push(`${file}: ${blocks.length} without an action (allowed ${allowed})\n  ${blocks.map(block => block.split('\n')[0]).join('\n  ')}`)
  }
  return found
}

describe('notices say what to do next', () => {
  it('reads the console\'s components', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(200)
    const notices = Object.values(SOURCES).flatMap(source => [...source.matchAll(NOTICE)])
    expect(notices.length).toBeGreaterThan(40)
  })

  it('gives every warning or error notice an action, or says on it why it needs none', () => {
    expect(offenders()).toEqual([])
  })

  it('keeps the pending list honest: a fixed notice leaves it', () => {
    const stale = [...PENDING].filter(([file, [count]]) => noticesWithoutAction(SOURCES[file] ?? '').length < count)
      .map(([file]) => file)
    expect(stale).toEqual([])
  })

  it('tells an action, a reason and a bare notice apart', () => {
    expect(noticesWithoutAction('<UiNotice tone="warning">Nothing works.</UiNotice>')).toHaveLength(1)
    expect(noticesWithoutAction('<UiNotice :tone="kind">Something.</UiNotice>')).toHaveLength(1)
    expect(noticesWithoutAction('<UiNotice tone="success">Saved.</UiNotice>')).toHaveLength(0)
    expect(noticesWithoutAction('<UiNotice tone="info">Not available here.</UiNotice>')).toHaveLength(1)
    expect(noticesWithoutAction('<UiNotice>Not available here.</UiNotice>')).toHaveLength(1)
    // An action that may not show leaves the notice without one.
    expect(noticesWithoutAction('<UiNotice tone="error">Lost.<template v-if="role" #actions><Button>Edit</Button></template></UiNotice>')).toHaveLength(1)
    expect(noticesWithoutAction('<UiNotice tone="error">Lost.<template #actions v-if="role"><Button>Edit</Button></template></UiNotice>')).toHaveLength(1)
    expect(noticesWithoutAction('<UiNotice tone="warning">No model.<template #actions><Button>Connect</Button></template></UiNotice>')).toHaveLength(0)
    expect(noticesWithoutAction('<UiNotice tone="error">Gone. <RouterLink to="/x">Open</RouterLink></UiNotice>')).toHaveLength(0)
    expect(noticesWithoutAction('<UiNotice tone="error" data-no-action="the button above tries again">Failed.</UiNotice>')).toHaveLength(0)
    expect(noticesWithoutAction('<UiNotice tone="error" data-no-action="ok">Failed.</UiNotice>')).toHaveLength(1)
  })
})
