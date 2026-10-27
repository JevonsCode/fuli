"""graph/12: Bole holds Agent resources, and the built-in `hr` occupation is
named for Agents: 「Agent 资源」/"Agent resources".

Earlier FULI shipped Bole with the `management` occupation and named `hr`
「人力资源」/"Human resources". Each space stores both, so only a confirmed
migration changes them, and only where the stored value is still exactly
what FULI shipped: a role or a text a person changed stays as they left it.
The key stays `hr`, so roles, tags and staffing history keep pointing at it.
"""

from .graph_format_journal import RecordJournal, RecordTouch
from .occupation_catalog import BUILTIN_AGENT_OCCUPATIONS, BUILTIN_OCCUPATIONS, TEXT_FIELDS
from .provider_values import now_utc
from .system_agents import SYSTEM_HR_AGENT_ID

SHIPPED_BOLE_ROLE = 'management'
SHIPPED_HR_TEXT = {
    'name_zh': '人力资源',
    'name_en': 'Human resources',
    'description_zh': '维护人员职责、招募安排和协作记录。',
    'description_en': 'Maintain role responsibilities, recruitment arrangements, and staffing records.',
}
_HR_KEY = 'hr'
_HR_TEXT = next({field: entry[field] for field in TEXT_FIELDS}
                for entry in BUILTIN_OCCUPATIONS if entry['key'] == _HR_KEY)


def _literal(text: str) -> str:
    # The journal runs a touch's match without parameters, so the shipped
    # values are written into it; they are constants above, never input.
    if "'" in text or '\\' in text:
        raise ValueError('a shipped value must not need escaping')
    return f"'{text}'"


_SHIPPED_BOLE = (
    f'MATCH (item:FuliProjectAgent {{agent_id: {_literal(SYSTEM_HR_AGENT_ID)}}}) '
    f'WHERE item.occupation_role = {_literal(SHIPPED_BOLE_ROLE)} '
)
_SHIPPED_HR = (
    f'MATCH (item:FuliOccupation {{key: {_literal(_HR_KEY)}}}) WHERE item.builtin = true AND ('
    + ' OR '.join(f'item.{field} = {_literal(text)}' for field, text in SHIPPED_HR_TEXT.items())
    + ') '
)
_HR_FIELDS = ',\n'.join(
    f'item.{field} = CASE WHEN item.{field} = $shipped.{field} THEN $current.{field} ELSE item.{field} END'
    for field in TEXT_FIELDS
)


async def pending_builtin_occupations(driver, _settings) -> list[str]:
    """Bole identities still on the shipped role, and `hr` occupations with
    any shipped text left."""
    records, _, _ = await driver.execute_query(
        _SHIPPED_BOLE + "RETURN 'bole:' + item.id AS key UNION "
        + _SHIPPED_HR + "RETURN 'hr:' + item.id AS key",
        routing_='r',
    )
    return sorted({str(record['key']) for record in records})


async def apply_builtin_occupations(driver, _settings, *, apply_id=None) -> None:
    now = now_utc()
    # A new occupation time: staffing demand counts only the work since it.
    await driver.execute_query(
        _SHIPPED_BOLE + 'SET item.occupation_role = $role, item.occupation_updated_at = $now',
        role=BUILTIN_AGENT_OCCUPATIONS[SYSTEM_HR_AGENT_ID], now=now,
    )
    # Field by field; a new revision makes an edit from an older page retry.
    await driver.execute_query(
        _SHIPPED_HR + 'SET ' + _HR_FIELDS + ''',
        item.revision = coalesce(item.revision, 0) + 1, item.updated_at = $now''',
        shipped=SHIPPED_HR_TEXT, current=_HR_TEXT, now=now,
    )


BUILTIN_OCCUPATION_JOURNAL = RecordJournal(touches=(
    RecordTouch('node', _SHIPPED_BOLE, ('occupation_role', 'occupation_updated_at')),
    RecordTouch('node', _SHIPPED_HR, (*TEXT_FIELDS, 'revision', 'updated_at')),
))
