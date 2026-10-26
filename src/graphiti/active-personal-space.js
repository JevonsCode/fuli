export function assertActivePersonalSpace(application, personalSpaceId) {
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Knowledge changes must use the active personal space');
  }
}
