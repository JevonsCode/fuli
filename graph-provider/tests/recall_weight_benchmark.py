"""Compare the actual entity-search ranking functions on synthetic judgments.

Run from the repository root: python graph-provider/tests/recall_weight_benchmark.py
Comparing against a Git revision needs that revision locally; no network or graph
database is used. The gate test compares the working tree with MAIN_BASELINE.
"""
import argparse
import ast
import json
import math
import re
import subprocess
import sys
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / 'fixtures' / 'recall_weight_benchmark.json'
BASE_REF = '92bdd16b65d0c7f1c643c235bdfc0203447866bc'
NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)
MAX_NDCG_DROP = 0.03
# BASE_REF's scores on this fixture, frozen so the gate needs no Git history
# (CI checks out one commit). Re-run with --base-ref to refresh them.
MAIN_BASELINE = {'ndcg5': 0.7973, 'mrr': 0.7, 'violations': 0}


def git_source(ref, name):
    if ref == 'WORKTREE':
        return (ROOT / 'graph-provider' / 'fuli_graph' / f'{name}.py').read_text(encoding='utf-8')
    return subprocess.run(
        ['git', 'show', f'{ref}:graph-provider/fuli_graph/{name}.py'],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding='utf-8',
    ).stdout


def definitions(source, names, namespace):
    """Execute the original named functions and constants, without service imports."""
    tree = ast.parse(source)
    selected = []
    def assigned_names(target):
        if isinstance(target, ast.Name):
            return {target.id}
        if isinstance(target, (ast.Tuple, ast.List)):
            return set().union(*(assigned_names(element) for element in target.elts))
        return set()

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(assigned_names(target) & names for target in node.targets):
            selected.append(node)
    found = {node.name for node in selected if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    found.update(name for node in selected if isinstance(node, ast.Assign)
                 for target in node.targets for name in assigned_names(target))
    missing = names - found
    if missing:
        raise ValueError(f'Ranking source is missing definitions: {sorted(missing)}')
    exec(compile(ast.Module(body=selected, type_ignores=[]), '<git ranking source>', 'exec'), namespace)


def confirmation_functions():
    try:
        from fuli_graph.models import _validate_confirmation_state, stored_confirmation_basis
        return _validate_confirmation_state, stored_confirmation_basis
    except ImportError as error:
        # Only the explicitly valid, synthetic fixture states below are supported.
        # This fallback never reads real records and leaves the ranking code intact.
        print(f'Confirmation model import unavailable ({error}); using synthetic basis adapter.', file=sys.stderr)

        def basis(value):
            value = value if isinstance(value, dict) else json.loads(value or '{}')
            actor = value.get('confirmed_by')
            return SimpleNamespace(
                confirmed_by=SimpleNamespace(**actor) if actor else None,
                confirmed_at=value.get('confirmed_at'),
                agent_policy_version=value.get('agent_policy_version'),
            )

        def validate(status, value):
            kind = value.confirmed_by.kind if value.confirmed_by else None
            valid = ((status == 'pending' and not kind and not value.confirmed_at and not value.agent_policy_version)
                     or (status == 'confirmed' and kind in ('user', 'authoritative_source')
                         and value.confirmed_at and not value.agent_policy_version)
                     or (status == 'agent_confirmed' and kind == 'agent'
                         and value.confirmed_at and value.agent_policy_version))
            if not valid:
                raise ValueError('Invalid synthetic confirmation')

        return validate, basis


def load_ranker(ref):
    search = git_source(ref, 'knowledge_search')
    weight = git_source(ref, 'knowledge_weight')
    values_ns = {'datetime': datetime, 'json': json}
    definitions(git_source(ref, 'provider_values'),
                {'native_datetime', 'normalized_text', 'json_object'}, values_ns)
    validate, basis = confirmation_functions()
    weight_ns = {'datetime': datetime, 'timezone': timezone, 'native_datetime': values_ns['native_datetime'],
                 '_validate_confirmation_state': validate, 'stored_confirmation_basis': basis}
    weight_names = {
        'effective_confirmation_status', 'knowledge_weight', 'ranking_weight', '_evidence_strength',
        '_recency', 'PENDING_BAND', 'AGENT_CONFIRMED_BAND', 'CONFIRMED_PERCENT',
        'USE_POINTS', 'USE_CAP', 'TASK_POINTS', 'TASK_CAP', 'SOURCE_POINTS', 'SOURCE_CAP',
        'NEGATIVE_POINTS', 'USE_HALF_LIFE_DAYS', 'ATTENTION_FACTOR',
    }
    if 'def ranking_weight(' in weight:
        definitions(weight, weight_names, weight_ns)
        weight_ns['knowledge_weight'] = partial(weight_ns['knowledge_weight'], now=NOW)

    search_ns = {'re': re, '_normalized': values_ns['normalized_text'], 'json_object': values_ns['json_object']}
    if 'def ranking_weight(' in weight:
        search_ns['ranking_weight'] = weight_ns['ranking_weight']
    names = {'_ranked_relevance', '_scope_precedence', '_dedupe_ranked_entities', '_relevance',
             '_terms', '_retrieval_aliases', '_alias_relevance', 'MIN_TERM_COVERAGE',
             'LATIN_QUERY_FILLERS', 'CHINESE_QUERY_FILLERS'}
    if 'def _tie_weight(' in search:
        names.add('_tie_weight')
    definitions(search, names, search_ns)
    return search_ns


def ranked_items(ranker, items, query):
    ranked = []
    for record in items:
        base = ranker['_relevance'](query, record)
        score = ranker['_ranked_relevance'](base, record)
        if score > 0:
            ranked.append((record, score))
    # This is the production entity-search deduplication and final ordering.
    return [record for record, _ in ranker['_dedupe_ranked_entities'](ranked, None)]


def metrics(ranker, fixture):
    ndcg, reciprocal, violations = [], [], 0
    for case in fixture['queries']:
        judgments = case['judgments']
        ranked = ranked_items(ranker, fixture['items'], case['query'])
        grades = [judgments.get(item['id'], 0) for item in ranked]
        dcg = sum((2 ** grade - 1) / math.log2(position + 2) for position, grade in enumerate(grades[:5]))
        ideal = sorted(judgments.values(), reverse=True)[:5]
        idcg = sum((2 ** grade - 1) / math.log2(position + 2) for position, grade in enumerate(ideal))
        ndcg.append(dcg / idcg)
        reciprocal.append(next((1 / (i + 1) for i, grade in enumerate(grades) if grade > 0), 0))
        top = ranked[:5]
        for i, item in enumerate(top):
            grade = judgments.get(item['id'], 0)
            if grade <= 0 or not (item['confirmation_status'] == 'pending' or item['requires_attention']):
                continue
            violations += sum(
                judgments.get(other['id'], 0) == grade
                and other['confirmation_status'] == 'confirmed' and not other['requires_attention']
                for other in top[i + 1:]
            )
    count = len(fixture['queries'])
    return {'ndcg5': sum(ndcg) / count, 'mrr': sum(reciprocal) / count, 'violations': violations}


def load_fixture():
    fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
    for item in fixture['items']:
        for field in ('last_used_at', 'created_at'):
            if item.get(field):
                item[field] = datetime.fromisoformat(item[field].replace('Z', '+00:00'))
    return fixture


def run(candidate_ref='WORKTREE', base_ref=None):
    fixture = load_fixture()
    base = metrics(load_ranker(base_ref), fixture) if base_ref else MAIN_BASELINE
    return base, metrics(load_ranker(candidate_ref), fixture)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-ref', default='WORKTREE', help='Git revision or WORKTREE (default)')
    parser.add_argument('--base-ref', default=None,
                        help=f'Git revision to score as the baseline (default: frozen scores of {BASE_REF[:8]})')
    args = parser.parse_args()
    main_result, candidate_result = run(args.candidate_ref, args.base_ref)
    print(f"{'ranking':<12} {'nDCG@5':>8} {'MRR':>8} {'violations@5':>14}")
    for name, result in [('main', main_result), ('candidate', candidate_result)]:
        print(f"{name:<12} {result['ndcg5']:>8.4f} {result['mrr']:>8.4f} {result['violations']:>14}")
    print(f'Pinned now: {NOW.isoformat()}; permitted nDCG@5 drop: {MAX_NDCG_DROP:.2f}')


if __name__ == '__main__':
    main()
