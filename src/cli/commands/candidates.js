import { requireSpace } from '../command-arguments.js';

export function candidates(app, args) {
  const personal = requireSpace(app, args[0]);
  const pending = app.agent.listCandidates(personal.id);
  console.log(pending.map((candidate) => `${candidate.id} ${candidate.reason ?? ''}`.trim())
    .join('\n'));
}

export function candidate(app, args) {
  const [candidateId, decision] = args;
  if (!candidateId || !decision) {
    throw new Error('Usage: candidate CANDIDATE_ID sync|personal_only|ignore');
  }
  const result = app.decideCandidate(candidateId, decision);
  console.log(`candidate ${result.status} ${result.id}`);
}
