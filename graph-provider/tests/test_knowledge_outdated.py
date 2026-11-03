"""The write-time staleness check's text similarity: how much of a
shorter note a newer one repeats, and when it is a duplicate rather than a
replacement. Needs no graph."""

import pytest

from fuli_graph.knowledge_outdated import similar_share


@pytest.mark.parametrize('new_text, old_text, expected', [
    # A restated runbook shares enough words to suspect the newer replaces the
    # older: flagged (share >= SIMILAR_TEXT_SHARE).
    ('restart the aurora service and check its logs afterwards',
     'restart aurora service then check the logs', 0.8333),
    ('build the aurora image then run the tests',
     'run tests after building aurora image', 0.6667),
    # Identical after case and space normalisation is a duplicate, not a
    # replacement.
    ('Deploy Aurora  To Staging', 'deploy aurora to staging', None),
    # Unrelated facts share no terms.
    ('the aurora deployment runs on port 8443',
     'team lunch is at noon on fridays', None),
    # Fewer than MIN_SHARED_TERMS shared terms is never flagged.
    ('restart aurora', 'restart aurora service', None),
    # A newer note that repeats every term of an older shorter one.
    ('restart the aurora service on port 8443', 'restart aurora service', 1.0),
    # Enough shared terms but below the share threshold: not flagged.
    ('restart aurora service verify health check metrics',
     'restart aurora service monitor logs inspect network', None),
    # Chinese: a restated runbook.
    ('重启极光服务然后检查日志', '先重启极光服务再检查日志', 0.7273),
    # Chinese duplicate.
    ('部署到生产环境', '部署到生产环境', None),
    # Chinese unrelated facts.
    ('极光服务运行在端口', '团队午饭时间安排', None),
    # Chinese fewer than MIN_SHARED_TERMS shared bigrams.
    ('极光服务', '极光部署', None),
    # Chinese newer note that repeats every bigram of an older shorter one.
    ('重启极光服务并检查日志', '重启极光服务', 1.0),
    # Chinese enough shared bigrams but below the share threshold.
    ('极光服务检查指标和监控', '极光服务查看日志和网络', None),
])
def test_similar_share_flags_repeats_not_duplicates(new_text, old_text, expected):
    assert similar_share(new_text, old_text) == expected
