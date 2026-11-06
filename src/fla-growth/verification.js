// The four verification states (rec#78, 11-06 addition 1) a task outcome or a
// learned experience shows: 人确认, 自动验证通过 (tests/CI evidence a verifier
// recorded), AI 评估通过 (Tonborg's independent acceptance), 尚未验证. A state
// is shown only from recorded evidence, each entry naming the record it rests
// on; nothing a model or an FLA says about itself counts. With several, the
// strongest is the state and the rest stay in evidence.
export const VERIFICATION_STATES = Object.freeze(['person_confirmed', 'auto_verified', 'ai_assessed', 'unverified']);

export function verificationOf(evidence) {
  const seen = new Set();
  const kept = evidence.filter((entry) => {
    if (!entry?.ref || !VERIFICATION_STATES.includes(entry.state) || entry.state === 'unverified') return false;
    const key = `${entry.state}:${entry.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { state: VERIFICATION_STATES.find(state => kept.some(entry => entry.state === state)) ?? 'unverified', evidence: kept };
}

// A judged Tonborg acceptance (src/judgment/review-verdicts.js): the passed
// attempt it judged is test evidence, its approval an independent assessment.
export function acceptanceEvidence(outcome) {
  const attempt = outcome.verification;
  return [
    ...(attempt?.outcome === 'pass' && attempt.evidence_refs?.length ? [{ state: 'auto_verified', source: 'verification',
      ref: attempt.attempt_id, refs: attempt.evidence_refs, taskId: outcome.taskId, at: outcome.at }] : []),
    ...(outcome.result === 'passed' ? [{ state: 'ai_assessed', source: 'tonborg', ref: outcome.decisionId, taskId: outcome.taskId, at: outcome.at }] : [])
  ];
}
