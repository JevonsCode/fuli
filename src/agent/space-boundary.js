import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { SpaceKind } from '../models.js';

export function requirePublicSpace(store, spaceId) {
  const space = store.getSpace(spaceId);
  if (!space) {
    throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, `Space not found: ${spaceId}`);
  }
  if (space.kind !== SpaceKind.PUBLIC) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      `Agent project reads require a public space: ${spaceId}`
    );
  }
  return space;
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
