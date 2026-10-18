import pytest
from pydantic import ValidationError
from fuli_graph.occupation_catalog import OccupationCreate, OccupationRevision, OccupationUpdate


def test_catalog_accepts_either_language_and_preserves_user_text_as_fallback():
    item = OccupationCreate(personal_space_id='space', name_en='API maintainer',
                            description_en='Maintain APIs and verify compatibility.')
    assert item.name_zh == item.name_en == 'API maintainer'
    assert item.description_zh == item.description_en


def test_create_treats_blank_optional_locales_as_missing():
    item = OccupationCreate(personal_space_id='space', name_en='API maintainer',
        description_en='Maintain APIs and verify compatibility.', name_zh=None, description_zh='  ')
    assert item.name_zh == item.name_en
    assert item.description_zh == item.description_en


@pytest.mark.parametrize('changes', [
    {'name_zh': ' '}, {'description_zh': ' '}, {'description_zh': '........'},
    {'description_zh': '短'}, {'name_zh': None}, {'name_zh': 12}, {'key': 'owned-key'}, {'builtin': True},
])
def test_create_requires_explicit_work_and_forbids_server_owned_fields(changes):
    with pytest.raises(ValidationError):
        OccupationCreate.model_validate({'personal_space_id': 'space', 'name_zh': '接口维护',
            'description_zh': '维护接口并验证完整行为。', **changes})


@pytest.mark.parametrize('revision', [-1, True, '1'])
def test_catalog_revision_is_a_nonnegative_integer(revision):
    with pytest.raises(ValidationError):
        OccupationRevision(personal_space_id='space', revision=revision)


def test_edit_requires_a_change_and_cannot_clear_status_or_text():
    for extra in ({}, {'status': None}, {'name_en': ''}, {'created_at': '2026-10-18'}):
        with pytest.raises(ValidationError):
            OccupationUpdate.model_validate({'personal_space_id': 'space', 'revision': 0, **extra})


def test_existing_demand_query_accepts_new_catalog_keys_without_accepting_arbitrary_labels():
    from fuli_graph.staffing_demand import StaffingDemandQuery
    keys = ['backend', 'hr', 'custom_0123456789abcdef0123456789abcdef']
    assert StaffingDemandQuery(personal_space_id='space', personal_project_id='project', occupations=keys).occupations == keys
    with pytest.raises(ValidationError):
        StaffingDemandQuery(personal_space_id='space', personal_project_id='project', occupations=['unknown'])
