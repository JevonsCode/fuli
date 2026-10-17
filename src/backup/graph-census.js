// A content-free census of one graph: node counts per label and relationship
// counts per type. Moving a graph between runtimes is only accepted when the
// census of the source and of the target are identical.

export const CENSUS_QUERIES = Object.freeze({
  labels: 'MATCH (n) UNWIND labels(n) AS name RETURN name, count(*) AS count ORDER BY name',
  types: 'MATCH ()-[r]->() RETURN type(r) AS name, count(*) AS count ORDER BY name',
  nodes: 'MATCH (n) RETURN "nodes" AS name, count(n) AS count',
  relationships: 'MATCH ()-[r]->() RETURN "relationships" AS name, count(r) AS count'
});

/** Builds a census from rows of [name, count] for each census query. */
export function censusFromRows(rowsByQuery) {
  const table = (rows) => Object.fromEntries(rows.map(([name, count]) => {
    if (typeof name !== 'string' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('The graph census returned an invalid row.');
    }
    return [name, count];
  }));
  const total = (rows) => {
    if (rows.length !== 1) throw new Error('The graph census returned an invalid total.');
    return table(rows)[rows[0][0]];
  };
  return {
    nodes: total(rowsByQuery.nodes),
    relationships: total(rowsByQuery.relationships),
    labels: table(rowsByQuery.labels),
    types: table(rowsByQuery.types)
  };
}

/** Parses cypher-shell `--format plain` output of a two-column census query. */
export function parsePlainCensusRows(output) {
  const lines = String(output).split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(1).map((line) => {
    const match = /^"((?:[^"\\]|\\.)*)", (\d+)$/.exec(line.trim());
    if (!match) throw new Error('The graph census output could not be read.');
    return [JSON.parse(`"${match[1]}"`), Number(match[2])];
  });
}

/** Lists every difference between two censuses; empty means identical. */
export function censusDifferences(source, target) {
  const differences = [];
  for (const key of ['nodes', 'relationships']) {
    if (source[key] !== target[key]) differences.push(`${key}: ${source[key]} → ${target[key]}`);
  }
  for (const group of ['labels', 'types']) {
    const names = new Set([...Object.keys(source[group]), ...Object.keys(target[group])]);
    for (const name of [...names].sort()) {
      const before = source[group][name] ?? 0;
      const after = target[group][name] ?? 0;
      if (before !== after) differences.push(`${group} ${name}: ${before} → ${after}`);
    }
  }
  return differences;
}
