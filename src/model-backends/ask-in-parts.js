// A batch of work asked of a model in one call, where one bad answer should
// cost only its own part: what a call leaves unanswered is asked again on its
// own, smaller, while the rest of the batch stands. Dreaming halves a part
// whose reply failed (src/dreaming/run.js); a Tonborg review asks again for
// only the candidates whose verdicts failed FULI's check (src/judgment/engine.js).
//
// ask(items) makes one call and answers the items to ask again (none when the
// call settled them all, whether answered or given up). split(items) answers
// the parts to ask those in. rounds bounds how many times an item is asked
// again. Answers the items still unanswered after the last round.
export async function askInParts(items, ask, { split, rounds = Infinity }) {
  const again = await ask(items);
  if (!again.length || rounds < 1) return again;
  const left = [];
  for (const part of split(again)) left.push(...await askInParts(part, ask, { split, rounds: rounds - 1 }));
  return left;
}
