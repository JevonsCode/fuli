import { Sensitivity } from '../models.js';
import { detectSensitiveContent } from './sensitive-content.js';

export function isRestrictedFact(fact) {
  return fact.sensitivity === Sensitivity.RESTRICTED ||
    [
      fact.subject,
      fact.predicate,
      fact.object
    ].some(hasSensitiveContent);
}

function hasSensitiveContent(text) {
  return detectSensitiveContent(text).restricted;
}
