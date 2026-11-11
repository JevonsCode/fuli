# Offline recall ranking benchmark

This is a synthetic, deterministic entity-ranking comparison. The JSON fixture has
120 records and 30 queries. The adjacent generator documents the scenarios and
semantic judgments: 3 means a direct answer, 1 related context, and 0 an incorrect
answer or an unjudged record. Direct answers with different confirmation states
receive the same relevance grade. The fixture is authored independently of the
ranking formulas; it is not a sample of real FULI knowledge.

From the repository root in PowerShell:

```powershell
$env:PYTHONPATH = "$PWD/graph-provider"
python graph-provider/tests/recall_weight_benchmark.py
python -m pytest graph-provider/tests/test_recall_weight_benchmark.py -q
```

The runner scores the working tree's search, weight and provider-values files
(`--candidate-ref WORKTREE`, the default) or any Git revision. The baseline is
commit `92bdd16b65d0c7f1c643c235bdfc0203447866bc` (main before the unified
weight); its scores are frozen in `MAIN_BASELINE` so the gate needs no Git
history. `--base-ref <revision>` re-scores a baseline from Git instead.

On 2026-11-01 the unified weight scored nDCG@5 0.8671, MRR 1.0 and
irrelevant@5 0.3533 against the baseline's 0.7973, 0.70 and 0.32, with no
trusted-first violations in either.

The runner extracts the real lexical relevance, ranking, and entity deduplication
functions and their dependencies from source. It pins the PR weight clock to
2026-11-01 UTC and parses fixture timestamps into native datetimes. If the model
module cannot be imported, a small adapter validates the fixture's synthetic
confirmation states while the actual ranking and weight functions still run.
The adapter is not suitable for real records.

The table reports mean nDCG@5 with gain `2^grade - 1`, MRR over all ranked
results (any grade greater than zero is relevant), the number of inverted
trusted-first pairs in the first five results, and `irrelevant@5`, the mean
share of grade-0 (irrelevant) items among each query's first five results. A
pair is an earlier pending or attention-flagged item followed by an unflagged
human/authoritative confirmed item with the same positive relevance grade.
Multiple pairs in a query each count. The test allows an absolute mean nDCG@5
decrease of at most **0.03**.

This measures entity ordering over the complete synthetic candidate set, with
pending records included. It does not measure graph retrieval, default pending
filtering, relationship search, tag reranking, scope/permission filtering, or
real-world recall. Judgments are intentionally small and synthetic, so a pass
is a regression signal, not proof of production recall quality. If the source
function structure changes, update the extraction list and review its semantics
instead of silently substituting a benchmark implementation.

On 2026-11-11 the query's terms are weighed by how few of the search's own
candidates carry them (`_term_weights`), and a record must carry a third of
that weight and one distinctive term (rec#111: records that only shared the
project's common words, such as 控制台 or FLA, were returned as matches). The
working tree then scored nDCG@5 0.9020, MRR 1.0 and irrelevant@5 0.2550
against 0.8671, 1.0 and 0.3633 just before it, with no trusted-first violations.

Also on 2026-11-11 the rank became relevance in whole steps with half of it
scaled by the weight (`RELEVANCE_SHARE`, `_relevance_band`) instead of
relevance times the weight. The benchmark does not move (0.9020, 1.0, 0.2550,
no trusted-first violations): its fixture has no query where an exact pending
match competes with a partial confirmed one. `test_knowledge_weight.py` holds
that case.
