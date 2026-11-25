// Results can be global references or shared across several projects. Only
// the actual record's replica marker identifies the computer it came from.
export async function labelProjectCopyResults(app, personalSpaceId, ranked, selected) {
  const kinds = ['facts', 'entities'];
  const ids = Object.fromEntries(kinds.map(kind => [kind, ranked[kind].filter(item => item.scope === 'personal').map(item => item.id)]));
  const rows = await app.personal.projectCopySources({ personalSpaceId, ...ids });
  const sources = new Map(rows.map(row => [row.kind + ':' + row.id, row]));
  const availability = new Map();
  function source(project) {
    if (!availability.has(project)) availability.set(project, app.runnerHost.projectSource(project));
    return availability.get(project);
  }
  let incomplete = selected.some(project => {
    const info = source(project);
    return info && (!info.readable || info.status === 'references_pending');
  });
  const result = {};
  for (const kind of kinds) {
    result[kind] = ranked[kind].flatMap(item => {
      const marker = item.scope === 'personal' && sources.get(kind + ':' + item.id);
      if (!marker) return [item];
      const projects = (marker.scopes ?? []).filter(scope => scope.startsWith('project:')).map(scope => scope.slice(8));
      if (!projects.length && marker.scopes?.includes('global')) return [item];
      const origins = projects.map(source);
      if (!origins.length || origins.some(info => !info?.readable || info.owner !== marker.owner)) {
        incomplete = true;
        return [];
      }
      return [{ ...item, projectCopySources: origins }];
    });
  }
  return { ...result, incomplete };
}
