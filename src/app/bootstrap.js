import { SpaceKind } from '../models.js';

export function bootstrapStarterSpaces(store) {
  const personal = store.createSpace('我', SpaceKind.PERSONAL);
  const space = store.createSpace('工作', SpaceKind.PUBLIC);
  const subscription = store.subscribe(personal.id, space.id);
  return { personal, space, subscription };
}
