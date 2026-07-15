import { formatContextPack } from '../../context-pack.js';
import { humanPredicate, requireSpace } from '../command-arguments.js';

export function search(app, args) {
  const [personalName, ...queryParts] = args;
  const personal = requireSpace(app, personalName);
  console.log(app.search({
    personalSpaceId: personal.id,
    query: queryParts.join(' ')
  }).answer);
}

export function timeline(app, args) {
  const [spaceName, ...subjectParts] = args;
  const space = requireSpace(app, spaceName);
  const facts = app.agent.timeline(space.id, subjectParts.join(' ') || space.name);
  console.log(facts.map((fact) =>
    `${fact.validAt} ${fact.predicate} ${fact.object}`).join('\n'));
}

export function rules(app, args) {
  const space = requireSpace(app, args[0]);
  const result = app.agent.projectRules(space.id);
  const lines = [
    ...result.forbidden.map((fact) => `forbids ${fact.object}`),
    ...result.parameters.map((fact) => `${humanPredicate(fact.predicate)} ${fact.object}`),
    ...result.links.map((fact) => `url ${fact.object}`)
  ];
  console.log(lines.join('\n'));
}

export function history(app, args) {
  const [spaceName, predicate] = args;
  const space = requireSpace(app, spaceName);
  const result = app.agent.factHistory({ spaceId: space.id, predicate });
  console.log(result.facts.map((fact) =>
    `${fact.current ? 'current' : 'historical'} ` +
    `${humanPredicate(fact.predicate)} ${fact.object}`).join('\n'));
}

export function context(app, args) {
  const [personalName, spaceName, ...queryParts] = args;
  const personal = requireSpace(app, personalName);
  const space = requireSpace(app, spaceName);
  console.log(formatContextPack(app.agent.contextPack({
    personalSpaceId: personal.id,
    spaceId: space.id,
    query: queryParts.join(' ')
  })));
}
