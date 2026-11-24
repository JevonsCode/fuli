// How many guest requests were refused today for a missing or wrong token
// (401) or a blocked source (429), so the person sees a guessing flood that
// never reaches 「最近被问」 (only valid tokens are recorded there). Counted per
// source address in memory for the current local day; a restart starts again
// from zero. At most ADDRESSES_TRACKED addresses are remembered; past that the
// address seen longest ago is forgotten first, so a flood from very many
// addresses is undercounted rather than unbounded.
const ADDRESSES_TRACKED = 4096;

export function createRefusalTally({ now = Date.now } = {}) {
  let day = null;
  const counts = new Map();

  const currentDay = () => {
    const today = new Date(now()).toDateString();
    if (today !== day) {
      day = today;
      counts.clear();
    }
  };

  return {
    record(address) {
      currentDay();
      const count = (counts.get(address) ?? 0) + 1;
      counts.delete(address);
      counts.set(address, count);
      if (counts.size > ADDRESSES_TRACKED) counts.delete(counts.keys().next().value);
    },
    today() {
      currentDay();
      let total = 0;
      for (const count of counts.values()) total += count;
      return total;
    }
  };
}
