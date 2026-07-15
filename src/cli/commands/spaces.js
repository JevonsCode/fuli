import { SpaceKind } from '../../models.js';
import { option, requireSpace } from '../command-arguments.js';

export function createSpace(app, args) {
  const [subcommand, name, ...rest] = args;
  if (subcommand !== 'create') {
    throw new Error('Usage: space create NAME --kind personal|public');
  }
  const kind = option(rest, '--kind') ?? SpaceKind.PUBLIC;
  const space = app.createSpace(name, kind);
  console.log(`${space.name} ${space.kind} ${space.id}`);
}

export function subscribe(app, args) {
  const [personalName, spaceName] = args;
  const personal = requireSpace(app, personalName);
  const space = requireSpace(app, spaceName);
  app.subscribe(personal.id, space.id);
  console.log(`${personal.name} subscribed ${space.name}`);
}
