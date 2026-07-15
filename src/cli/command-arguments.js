export function option(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

export function requireSpace(app, name) {
  const space = app.resolveSpace({ name });
  if (!space) throw new Error(`Space not found: ${name}`);
  return space;
}

export function humanPredicate(predicate) {
  return predicate.startsWith('has_') ? predicate.slice(4) : predicate;
}
