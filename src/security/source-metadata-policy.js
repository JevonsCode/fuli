import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { detectSensitiveContent } from './sensitive-content.js';

export function assertSafeSourceMetadata(sourceKind, sourceUri, errorMessage) {
  if ([sourceKind, sourceUri].some((text) => detectSensitiveContent(text).restricted)) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, errorMessage);
  }
}
