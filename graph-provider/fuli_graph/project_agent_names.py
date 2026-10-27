"""Stable product nicknames, independent of identity, assignment and work status.

An Agent's role lives in ``profile.name`` (with its occupation and
responsibility); ``profile.display_name`` is the person-like nickname people
call it by. A new Agent gets a nickname no other Agent in its personal space
uses (new_agent_display_name). An existing Agent is never renamed here; one
whose shown name reads as a job (title_like) is only offered a free nickname.
"""
import hashlib
import re

from .name_identity import identity_key


FIRST_NAMES = (
    'Milo', 'Nova', 'Arlo', 'Nora', 'Theo', 'Iris', 'Remy', 'Lena',
    'Finn', 'Cleo', 'Ezra', 'Mira', 'Jude', 'Lyra', 'Owen', 'Cora',
    'Alex', 'Robin', 'Jamie', 'Rowan', 'Casey', 'Avery', 'Morgan', 'Riley',
    'Ellis', 'Quinn', 'Sage', 'Blair', 'Reese', 'Emery', 'Drew', 'Sky',
)
LAST_NAMES = (
    'Reed', 'Lane', 'Vale', 'Brook', 'Wren', 'Stone', 'Park', 'Finch',
    'Lake', 'Ash', 'Birch', 'Hill', 'West', 'Woods', 'Dale', 'Hart',
    'Gray', 'Bell', 'Hayes', 'Blake', 'Lowe', 'Frost', 'Green', 'Page',
    'Wells', 'Shaw', 'Fox', 'Snow', 'Field', 'North', 'Ray', 'Cole',
)
ROLE_NAME = re.compile(
    r'(工程师|协调人|开发者|设计师|架构师|审计员|项目经理|负责人|专员|助手|智能体|验证员|测试员|记录员)'
    r'|\b(agent|engineer|coordinator|specialist|developer|reviewer|tester|verifier|auditor|designer|architect|implementer)\b',
    re.IGNORECASE,
)
# More job words, used only to name a new Agent or suggest a rename: reads keep
# ROLE_NAME, so no existing Agent's shown name changes.
JOB_TITLE = re.compile(
    r'(专责|专家|顾问|经理|主管|总监|主理人|分析师|编辑|写手|运营|策划|研究员|助理|文案|讲师)'
    r'|\b(manager|writer|analyst|editor|assistant|lead|owner|expert|consultant|researcher|planner|operator'
    r'|officer|strategist|copywriter|author|curator|bot|admin|administrator|producer|marketer)s?\b',
    re.IGNORECASE,
)
NAME_LIMIT = 160
NICKNAMES = len(FIRST_NAMES) * len(LAST_NAMES)


def agent_display_name(agent_id: str, name: str, display_name: str | None = None):
    if display_name:
        return display_name
    if agent_id == 'fuli-project-coordinator' and name == '项目协调人':
        return 'Orion'
    if not ROLE_NAME.search(name):
        return name
    digest = hashlib.sha256(agent_id.encode()).digest()
    return f'{FIRST_NAMES[digest[0] % len(FIRST_NAMES)]} {LAST_NAMES[digest[1] % len(LAST_NAMES)]}'


def title_like(name: str) -> bool:
    """Whether a name reads as a job title ("PPT 专责", "design Agent") rather than a person."""
    return bool(ROLE_NAME.search(name) or JOB_TITLE.search(name))


def unique_nickname(agent_id: str, taken: set[str]) -> str:
    """The first free nickname from the Agent's own place in the list.

    It starts where agent_display_name derives a legacy nickname, so an Agent
    whose derived name is still free gets that name. ``taken`` holds identity keys.
    """
    digest = hashlib.sha256(agent_id.encode()).digest()
    start = (digest[0] % len(FIRST_NAMES)) * len(LAST_NAMES) + digest[1] % len(LAST_NAMES)
    names = (_nickname((start + step) % NICKNAMES) for step in range(NICKNAMES))
    free = next((name for name in names if identity_key(name) not in taken), None)
    return free or _numbered(_nickname(start), taken)


def new_agent_display_name(agent_id: str, name: str, display_name: str | None, taken: set[str]) -> str:
    """The nickname a new Agent starts with: the one given when it reads as a
    person (numbered when another Agent already has it), otherwise a generated one."""
    given = display_name or name
    if title_like(given):
        return unique_nickname(agent_id, taken)
    return given if identity_key(given) not in taken else _numbered(given, taken)


def _nickname(index: int) -> str:
    return f'{FIRST_NAMES[index // len(LAST_NAMES)]} {LAST_NAMES[index % len(LAST_NAMES)]}'


def _numbered(name: str, taken: set[str]) -> str:
    number = 2
    while True:
        suffix = f' {number}'
        candidate = name[:NAME_LIMIT - len(suffix)].rstrip() + suffix
        if identity_key(candidate) not in taken:
            return candidate
        number += 1
