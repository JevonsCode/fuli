import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { Sensitivity, SpaceKind } from '../models.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';

export function validateLensWriteInput(
  store,
  { personalSpaceId, texts, sensitivity, confidence }
) {
  requirePersonalSpace(store, personalSpaceId);
  assertSafeLensTexts(texts);
  if (!Object.values(Sensitivity).includes(sensitivity)) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      `Invalid sensitivity: ${sensitivity}`
    );
  }
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      'Confidence must be between 0 and 1'
    );
  }
}

export function requirePersonalSpace(store, spaceId) {
  const space = store.getSpace(spaceId);
  if (!space) {
    throw new ApplicationError(
      ApplicationErrorCode.NOT_FOUND,
      `Personal space not found: ${spaceId}`
    );
  }
  if (space.kind !== SpaceKind.PERSONAL) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      `Space is not personal: ${spaceId}`
    );
  }
  return space;
}

export function assertSafeLensTexts(texts) {
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Lens text must be a nonempty string'
      );
    }
    if (detectSensitiveContent(text).restricted) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Sensitive content is not allowed in Personal Lens'
      );
    }
  }
}
