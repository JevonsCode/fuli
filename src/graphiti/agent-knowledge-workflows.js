// The Agent knowledge workflows' public surface. Each capability lives in its
// own module; this file only names what Agents and the application call.
export { beginTaskContext, beginTaskFromPreferences } from './task-context-entry.js';
export { checkpointTaskKnowledge } from './task-knowledge-checkpoint.js';
export { recordDecisionTrace } from './decision-trace.js';
export { recordKnowledgeFeedback } from './knowledge-feedback.js';
export { discoverCommonKnowledgeCandidates, providerCommonKnowledgePromotion } from './common-knowledge-candidates.js';
export {
  applyPersonalGlobalPreferenceDecision,
  discoverPersonalGlobalPreferenceCandidates,
  previewPersonalGlobalPreferenceDecision
} from './personal-global-preference-candidates.js';
