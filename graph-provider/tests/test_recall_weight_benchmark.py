from recall_weight_benchmark import MAIN_BASELINE, MAX_NDCG_DROP, run


def test_working_tree_recall_quality_against_pinned_main():
    _, candidate = run()
    assert candidate['ndcg5'] >= MAIN_BASELINE['ndcg5'] - MAX_NDCG_DROP, candidate
