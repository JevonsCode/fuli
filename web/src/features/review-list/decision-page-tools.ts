import { z } from 'zod'

import { definePageTool } from '@/features/webmcp/page-tool'

import { oneLine, type ReviewLine } from './review-list'
import type { useReviewList } from './review-store'

// 待决策's tool for the browser's AI agent (WebMCP): reading only. A decision
// made from this page would be recorded as the person's own (人确认), and the
// page cannot prove the person rather than the agent made it (rec#10 on
// fuli PR 784). The agent sorts the list and suggests; the person decides with
// their own clicks, or tells their MCP Agent, which relays their exact words.

const LINE_TEXT = 60
type ReviewList = ReturnType<typeof useReviewList>

const group = (list: ReviewList, name: 'questions' | 'pending' | 'confirmed') => list.list[name].map((line: ReviewLine) => ({
  key: line.key, text: oneLine(line.text, LINE_TEXT * 2), projectId: line.projectId, proposer: line.proposer,
  question: line.review?.ask ?? null, guess: line.review?.guess ?? null,
}))

export function decisionPageTools(list: ReviewList) {
  return [
    definePageTool({
      name: 'fuli_list_decisions',
      title: 'List what waits for the person',
      description: 'The 待决策 list: Tonborg\'s questions (one yes/no sentence each, its guess first), pending knowledge, and what Tonborg confirmed. Suggest; the person decides each line on this page.',
      input: z.object({}),
      routes: [],
      readOnly: true,
      untrustedContent: true,
      async run() {
        if (!list.loaded) await list.refresh()
        return { questions: group(list, 'questions'), pending: group(list, 'pending'), confirmedByTonborg: group(list, 'confirmed') }
      },
    }),
  ]
}
