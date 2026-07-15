import { option, requireSpace } from '../command-arguments.js';

export function remember(app, args) {
  const [personalName, ...rest] = args;
  const personal = requireSpace(app, personalName);
  const targetName = option(rest, '--target');
  const target = targetName ? requireSpace(app, targetName) : null;
  const body = option(rest, '--text');
  if (!body) throw new Error('remember requires --text');

  const result = app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: target?.id ?? null,
    sourceKind: option(rest, '--source-kind') ?? 'agent',
    body
  });
  console.log(`remembered ${result.route}`);
}

export function observe(app, args) {
  const [personalName, ...rest] = args;
  const personal = requireSpace(app, personalName);
  const targetName = option(rest, '--target');
  const target = targetName ? requireSpace(app, targetName) : null;
  const result = app.observe({
    personalSpaceId: personal.id,
    targetSpaceId: target?.id ?? null,
    cwd: option(rest, '--cwd') ?? process.cwd()
  });
  const suffix = result.observed.length === 1 ? 'change' : 'changes';
  console.log(`observed ${result.observed.length} ${suffix}`);
}
