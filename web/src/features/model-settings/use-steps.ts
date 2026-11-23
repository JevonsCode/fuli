// One step of how a model use works (rec issue 143): what the step does and, when
// the page has seen it, its state. A state is set only from what the server
// answered (a count it returned, a run it reports, a failure it named); a
// step the page has not seen has none and reads as an explanation only.
type UseStepState = 'active' | 'done' | 'failed'
export type UseStep = {
  id: string
  title: string
  detail: string
  state?: UseStepState
  // Written of total, when the server reports both while the step runs.
  progress?: { done: number; total: number }
}
