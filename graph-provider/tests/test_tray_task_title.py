from fuli_graph.store_task_contexts import shown_task_title


def test_the_tray_title_is_the_board_title_else_the_summary_first_line():
    assert shown_task_title('Synthetic board task', '{"summary": "Synthetic summary"}') == 'Synthetic board task'
    assert shown_task_title(None, '{"summary": "\\n  Synthetic first line\\nsecond"}') == 'Synthetic first line'
    assert shown_task_title(None, '{"summary": "' + 'x' * 80 + '"}') == 'x' * 60


def test_a_work_log_that_does_not_read_gives_no_summary():
    for log in ('not json', '[]', '{"summary": 42}', '{"summary": null}', None):
        assert shown_task_title(None, log) is None, log
    assert shown_task_title('Synthetic board task', '{"summary": 42}') == 'Synthetic board task'
