# Recall rate benchmark

How often the right project knowledge and the right preferences actually reach
the Agent, and what they cost on the way. Every case states the right answer,
so a number here means "the right thing arrived", not "something arrived".

```bash
npm run measure:recall-rate
npm run measure:recall-rate -- --json /tmp/recall-rate.json
npm run measure:recall-rate -- --without-retrieval-terms
```

About 2 seconds, most of it Python start-up. **No Neo4j, no embedding
model, no network, no model call.** It needs the Provider importable: the
`.venv` from the Provider validation steps in `docs/development.md`, or any
Python 3.12 that can `import fuli_graph`. `FULI_BENCHMARK_PYTHON=<path>` picks
one explicitly.

## What it measures

A fictional personal space with two projects (`knowledge-world.js`): project
facts (addresses, commands, decisions, runbooks), global and project
preferences, scope-qualified preferences, superseded historical versions, and
near misses that share words with the right answer but are the wrong answer.
Nothing names a real person, project, host or path.

Hard cases carry a `category` and are also reported apart: a question in other
words than the answer's (`synonym`), one that shares only the project's name
with its answer (`project_name_only`), the same item name in two projects in
scope (`same_name`), and items written without retrieval terms
(`no_retrieval_terms`). `--without-retrieval-terms` ranks the same world with
every hand-written retrieval term removed, which shows how much of a result
the terms carry rather than the item's own words.

**A — preferences the entry delivers on its own.** Runs the real
`preferenceTaskApplicability` for each task scope.
*should deliver / delivered*, *must not deliver / delivered*, and the second
again for scope-qualified preferences alone, where a wrong delivery has already
changed a deliverable (rec#111, 2026-11-22).

**B — knowledge the entry recalls on its own.** Runs the real
`recallTaskKnowledge`, including its own query planning, focus filter,
confirmed-first ordering and 4 KiB budget.
*should recall / recalled*, *must not recall / recalled*, precision of what was
delivered, bytes, approximate tokens, wall time.

**C — searches the Agent makes for itself.** Runs the real
`searchCurrentProjectKnowledge` and its 8 KiB page budget over ranked results.
*gold in the top 5*, *MRR*, forbidden items in the top 5, **gold the Provider
ranked but the page budget did not hand over**, items delivered vs ranked,
bytes, approximate tokens, and ranking time — each also split by query
language (zh / en / mixed).

Ranks in C are over the order the page budget actually spends in: each query's
facts and entities interleaved by rank, queries round-robin. That is what an
Agent reads, and what gets cut.

## How the ranking is real

`rank_fixture_world.py` imports `fuli_graph.knowledge_search` and runs the
Provider's own `_edge_matches` (relationship relevance), `_relevance`,
`_term_weights` (entities), `_ranked_relevance`, `knowledge_weight`, the
documented sort keys and the dedupe, then projects results through the real
`fact_result` / `_entity_search_result`. Nothing is scored in JavaScript, and a
result item here is byte-for-byte the shape `/v1/search` returns.

Candidates are drawn per query, as the search draws them. The search takes
what Graphiti's hybrid search returns (at most `min(max(limit * 8, 40), 100)`)
plus what retrieval terms find, and a relationship's position in that list is
part of its score; the mirror takes the relationships that share at least one
term with the query, in fixture order, under the same cap, plus the
retrieval-term finds. Entities are scored over everything in scope, with
their term weights, as the search scores them.

## What it does not cover

- Graphiti's own hybrid search: its BM25 tokenizer, its candidates found by
  meaning, its order. The stand-in above shares only the shape: a real pool
  differs in which relationships are in it and in their order, and a
  relationship the stand-in finds by a shared term the real search may never
  return (or the reverse).
- Authorization, visitor scope, Cypher-side filtering, tag re-ranking.
- Semantic vectors and RRF fusion: the fixture stores no vectors, so
  `standing_out` contributes nothing, exactly as it does on an install with
  fewer than 12 vectored items in scope.
- Provider wall time. C's ranking time is the scoring stage alone, on 37 items,
  in one warm process. It is a regression signal, not a latency measurement;
  rec#126's segmented timing is the method for that.
- Real knowledge volume and real questions. 37 items, and a query ranks about
  4 of the 14 it scores, so a right answer meets little competition; the
  questions were written knowing the answers. A full score here says the
  pieces that are real code agree with the stated answers on this world, not
  what share of real questions find their answer.

`rank_fixture_world.py` mirrors about twenty lines of `search_knowledge`'s
candidate, scoring and ordering stage rather than calling it (that stage is
inseparable from its Cypher reads). `test_recall_rate_mirror.py` fails if the
functions it mirrors change shape, or if the search's candidate cap or its
relationship scoring call changes, so those cannot drift silently; the rest of
the flow can.
