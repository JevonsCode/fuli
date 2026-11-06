import { z } from 'zod'

import { t } from '@/i18n'
import { definePageTool, PageToolError } from '@/features/webmcp/page-tool'

import { oneLine, type ReviewLine } from './review-list'
import type { useReviewList } from './review-store'

// 待决策's tools for the browser's AI agent (WebMCP). Confirming or dropping
// an item here is recorded as the person's own decision (人确认), so the
// agent may propose a batch and the person allows it with one click on this
// page; an Agent that decides with its own judgment uses its own tools
// (revise_personal_knowledge) and is recorded as itself.

const CONFIRM_LINES = 5
const LINE_TEXT = 60
type ReviewList = ReturnType<typeof useReviewList>

const group = (list: ReviewList, name: 'questions' | 'pending' | 'confirmed') => list.list[name].map((line: ReviewLine) => ({
  key: line.key, text: oneLine(line.text, LINE_TEXT * 2), projectId: line.projectId, proposer: line.proposer,
  question: line.review?.question ?? null, guess: line.review?.guess ?? null,
}))

export function decisionPageTools(list: ReviewList) {
  return [
    definePageTool({
      name: 'fuli_list_decisions',
      title: 'List what waits for the person',
      description: 'The 待决策 list: Tonborg\'s questions with its guess, pending knowledge, and what Tonborg confirmed. Each line has a key for fuli_decide.',
      input: z.object({}),
      routes: [],
      readOnly: true,
      async run() {
        if (!list.loaded) await list.refresh()
        return { questions: group(list, 'questions'), pending: group(list, 'pending'), confirmedByTonborg: group(list, 'confirmed') }
      },
    }),
    definePageTool({
      name: 'fuli_decide',
      title: 'Confirm or drop waiting items',
      description: 'Confirm (keep) or drop pending items by key, as the person\'s decision. The person allows the whole batch with one click on the page. Items to edit stay for the person.',
      input: z.object({ decisions: z.array(z.object({ key: z.string().min(1), action: z.enum(['confirm', 'drop']) })).min(1).max(100) }),
      routes: ['PATCH /api/knowledge/:itemKind/:itemId', 'POST /api/judgment/feedback'],
      async run(input, context) {
        const waiting = new Map([...list.list.questions, ...list.list.pending].map(line => [line.key, line]))
        const chosen = input.decisions.map(({ key, action }) => {
          const line = waiting.get(key)
          if (!line?.item) throw new PageToolError('invalid_input', `Nothing waits under ${key}; read fuli_list_decisions again`)
          return { line, action }
        })
        const lines = chosen.slice(0, CONFIRM_LINES).map(({ line, action }) =>
          `${t(`reviewList.actions.${action}`)} · ${oneLine(line.text, LINE_TEXT)}`)
        if (chosen.length > CONFIRM_LINES) lines.push(t('aiHelp.webmcp.confirm.more', { count: chosen.length - CONFIRM_LINES }))
        await context.personAllows({ title: t('aiHelp.webmcp.confirm.decide.title', { count: chosen.length }), lines })
        const done: string[] = []
        for (const { line, action } of chosen) {
          if (context.signal.aborted) break
          if (await list.act(line, action)) done.push(line.key)
        }
        return { done, notDone: chosen.map(({ line }) => line.key).filter(key => !done.includes(key)) }
      },
    }),
  ]
}
