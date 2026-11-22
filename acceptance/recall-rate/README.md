# Recall rate benchmark

How often the right project knowledge and the right preferences actually reach
the Agent, and what they cost on the way. Every case states the right answer,
so a number here means "the right thing arrived", not "something arrived".

```bash
npm run measure:recall-rate
npm run measure:recall-rate -- --json /tmp/recall-rate.json
```

About 25 seconds, almost all of it Python start-up. **No Neo4j, no embedding
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
Provider's own `_edge_relevance`, `_relevance`, `_term_weights`,
`_ranked_relevance`, `knowledge_weight`, the documented sort keys and the
dedupe, then projects results through the real `fact_result` /
`_entity_search_result`. Nothing is scored in JavaScript, and a result item
here is byte-for-byte the shape `/v1/search` returns.

## What it does not cover

- Graphiti's own hybrid candidate generation. Fixture order stands in for it,
  which only moves the `semantic_order` tie-break inside a relevance band.
- Authorization, visitor scope, Cypher-side filtering, tag re-ranking.
- Semantic vectors and RRF fusion: the fixture stores no vectors, so
  `standing_out` contributes nothing, exactly as it does on an install with
  fewer than 12 vectored items in scope.
- Provider wall time. C's ranking time is the scoring stage alone, on 32 items,
  in one warm process. It is a regression signal, not a latency measurement;
  rec#126's segmented timing is the method for that.
- Real knowledge volume. 32 items is small, so IDF has little to work with;
  a bigger store makes term weighing matter more, not less.

`rank_fixture_world.py` mirrors about fifteen lines of `search_knowledge`'s
scoring and ordering stage rather than calling it (that stage is inseparable
from its Cypher reads). `test_recall_rate_mirror.py` fails if the functions it
mirrors change shape, so the mirror cannot drift silently.
