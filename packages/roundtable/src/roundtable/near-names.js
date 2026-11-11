// Names a person most likely meant when what they typed matches no Agent
// (rec#110: 「astra」 for Astro): a name within a small edit distance, ignoring
// case. Only offered as a question to the person, never used as the match.
const MAX_SUGGESTIONS = 3;

export function nearNames(needle, agents, namesOf) {
  const wanted = String(needle ?? '').trim().toLowerCase();
  if (wanted.length < 3) return [];
  const limit = Math.max(1, Math.floor(wanted.length / 4));
  return agents.map(agent => ({ agent, distance: Math.min(...namesOf(agent).filter(Boolean)
    .map(name => editDistance(wanted, name.toLowerCase()))) }))
    .filter(entry => entry.distance <= limit)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_SUGGESTIONS).map(entry => entry.agent);
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}
