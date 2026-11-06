from fuli_graph.store_task_contexts import foreign_client_detail


def test_foreign_client_token_names_both_clients_and_the_one_step_that_works():
    # rec#97: a Claude Code hook token used through a FULI connection registered as claude.
    detail = foreign_client_detail('claude_code', 'claude')
    assert detail.startswith('Task context not found for this client: it was begun in claude_code, not claude. ')
    assert 'This FULI connection runs as claude, so a claude_code token never works through it.' in detail
    assert 'Call get_collaboration_preferences through this connection for a token of its own' in detail
    assert 'pass that token to every call made through it, including checkpoint_task_knowledge.' in detail
