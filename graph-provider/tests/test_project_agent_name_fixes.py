"""Who keeps a name several Agents share, what the others become and why
(project_agent_name_fixes.py). Synthetic Agents only."""
from fuli_graph.name_identity import identity_key
from fuli_graph.project_agent_name_fixes import NameHolder, called_by, name_fix_plan
from fuli_graph.project_agent_names import FIRST_NAMES, LAST_NAMES, is_generated_nickname


def holder(agent_id, name='Morgan Vale', **facts):
    return NameHolder(agent_id=agent_id, name=name, names=called_by(agent_id, name), **facts)


def settled(groups):
    """agent_id -> (keeps, gave_way) over every group."""
    return {member.agent_id: (member.keeps, member.gave_way) for group in groups for member in group.members}


def test_each_rule_in_order_decides_who_keeps_the_name():
    cases = [
        # (keeper, giver, the rule the giver lost on)
        (holder('a'), holder('b', status='archived', work=9), 'dismissed'),
        (holder('a'), holder('b', test=True, work=9), 'test'),
        (holder('a', person_named=True), holder('b', work=9), 'person_named'),
        # A lead FULI hired for a temporary or conversation scope gives way to
        # an FLA working in a real project, however long its sessions were.
        (holder('a', work=1), holder('b', temporary_only=True, work=40, recent=9e9), 'temporary_lead'),
        (holder('a', work=2), holder('b', work=1, recent=9e9), 'less_work'),
        (holder('a', work=1, recent=2.0), holder('b', work=1, recent=1.0), 'less_recent'),
        (holder('b', created=1.0), holder('a', created=2.0), 'later'),
    ]
    for keeper, giver, rule in cases:
        assert settled(name_fix_plan([giver, keeper])) == {keeper.agent_id: (True, None),
                                                           giver.agent_id: (False, rule)}, rule


def test_a_built_in_role_keeps_its_names_whoever_the_person_picks():
    fla = holder('bole-fla', 'Bole', work=5)
    role = holder('employee.bole', '伯乐')
    groups = name_fix_plan([fla, role], frozenset({'bole-fla'}))
    assert settled(groups) == {'employee.bole': (True, None), 'bole-fla': (False, 'built_in_role')}
    assert groups[0].name == '伯乐'


def test_the_person_may_pick_who_keeps_a_name_and_the_others_say_so():
    first, second, third = holder('a', work=5), holder('b', work=3), holder('c', work=1)
    assert settled(name_fix_plan([first, second, third], frozenset({'c'}))) == {
        'c': (True, None), 'a': (False, 'person_chose'), 'b': (False, 'person_chose')}
    # A pick outside any shared name changes nothing.
    assert settled(name_fix_plan([first, second], frozenset({'z'})))['a'] == (True, None)


def test_new_names_are_free_generated_and_distinct_across_the_space():
    taken = holder('x', 'Nova Reed')
    plan = name_fix_plan([holder('a', work=2), holder('b'), holder('c', 'Iris Vale', work=1),
                          holder('d', 'iris  VALE'), taken])
    new = [member.new_name for group in plan for member in group.members if not member.keeps]
    assert len(new) == 2 and len({identity_key(name) for name in new}) == 2
    assert all(is_generated_nickname(name) for name in new)
    assert not {identity_key(name) for name in new} & {'morgan vale', 'iris vale', 'nova reed'}
    # Asking again gives the same names, so what the person saw is what is applied.
    assert plan == name_fix_plan([holder('a', work=2), holder('b'), holder('c', 'Iris Vale', work=1),
                                  holder('d', 'iris  VALE'), taken])


def test_no_shared_name_no_plan():
    assert name_fix_plan([holder('a'), holder('b', 'Iris Vale')]) == []


def test_generated_names_are_told_from_names_a_person_gave():
    assert is_generated_nickname(f'{FIRST_NAMES[0]} {LAST_NAMES[0]}')
    assert is_generated_nickname(f'{FIRST_NAMES[1]} {LAST_NAMES[2]}-{LAST_NAMES[3]}')
    assert is_generated_nickname(f'{FIRST_NAMES[1]} {LAST_NAMES[2]} 2')
    assert not any(is_generated_nickname(name) for name in ('青禾', 'Jefa', '林夏 Lin', 'PPT 专责', ''))
