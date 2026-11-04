// What Tonborg reviews knowledge by, as the console says it: each line is one
// clause of the rubric in src/judgment/review-prompt.js and the preference rules
// in src/judgment/preference-receipt.js, words in i18n judgment.standards.*.
// judgment-standards.spec.ts fails when a clause it quotes changes.
export const JUDGMENT_STANDARD_GROUPS = [
  { id: 'preference', lines: ['ownWords', 'standing', 'sameMeaning', 'noConflict', 'noAmbiguity', 'realContent'] },
  { id: 'fact', lines: ['supported'] },
  { id: 'escalate', lines: ['contested', 'consequential', 'preferenceConfirmation', 'oneOff', 'unknownScope', 'relevantConflict', 'unreadSource', 'injection'] },
  { id: 'always', lines: ['evidenceOnly', 'untrustedData', 'respect', 'feedback', 'noInvention', 'selectedOnly', 'keepsPreference', 'noPermission', 'oneDecision', 'quality', 'confidence'] },
] as const
