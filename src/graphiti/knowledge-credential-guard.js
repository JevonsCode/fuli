import { ApplicationError } from '../app/application-error.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';

export function assertNoCredentials(input) {
  const content = JSON.stringify({
    name: input.name,
    sourceDescription: input.sourceDescription,
    sourceUri: input.sourceUri,
    sourceExcerpt: input.sourceExcerpt,
    summary: input.summary,
    entities: input.entities,
    relationships: input.relationships
  });
  if (detectSensitiveContent(content).restricted) {
    throw new ApplicationError(
      'validation',
      'Structured knowledge contains credentials and cannot be stored'
    );
  }
}

export function assertSafeKnowledgeMutation(input) {
  const content = JSON.stringify({
    reason: input.reason,
    name: input.name,
    summary: input.summary,
    fact: input.fact,
    note: input.note,
    newProjectName: input.newProjectName,
    newProjectPurpose: input.newProjectPurpose,
    humanConfirmationReason: input.humanConfirmationReason,
    batchItems: input.items?.map((item) => ({
      existenceReason: item.existenceReason,
      quadrantReason: item.quadrantReason
    }))
  });
  if (detectSensitiveContent(content).restricted) {
    throw new ApplicationError(
      'validation',
      'Knowledge revision contains credentials and cannot be stored'
    );
  }
}
