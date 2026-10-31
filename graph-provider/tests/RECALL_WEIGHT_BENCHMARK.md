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

On 2026-11-01 the unified weight scored nDCG@5 0.8671 and MRR 1.0 against the
baseline's 0.7973 and 0.70, with no trusted-first violations in either.

The runner extracts the real lexical relevance, ranking, and entity deduplication
functions and their dependencies from source. It pins the PR weight clock to
2026-11-01 UTC and parses fixture timestamps into native datetimes. If the model
module cannot be imported, a small adapter validates the fixture's synthetic
confirmation states while the actual ranking and weight functions still run.
The adapter is not suitable for real records.

The table reports mean nDCG@5 with gain `2^grade - 1`, MRR over all ranked
results (any grade greater than zero is relevant), and the number of inverted
trusted-first pairs in the first five results. A pair is an earlier pending or
attention-flagged item followed by an unflagged human/authoritative confirmed
item with the same positive relevance grade. Multiple pairs in a query each
count. The test allows an absolute mean nDCG@5 decrease of at most **0.03**.

This measures entity ordering over the complete synthetic candidate set, with
pending records included. It does not measure graph retrieval, default pending
filtering, relationship search, tag reranking, scope/permission filtering, or
real-world recall. Judgments are intentionally small and synthetic, so a pass
is a regression signal, not proof of production recall quality. If the source
function structure changes, update the extraction list and review its semantics
instead of silently substituting a benchmark implementation.
