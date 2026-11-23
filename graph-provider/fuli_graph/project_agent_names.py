"""Stable product nicknames, independent of identity, assignment and work status.

An Agent's role lives in ``profile.name`` (with its occupation and
responsibility); ``profile.display_name`` is the person-like nickname people
call it by. A new Agent gets a nickname no other Agent in its personal space
uses (new_agent_display_name). An existing Agent is never renamed here; one
whose shown name reads as a job (title_like) is only offered a free nickname.
A nickname given for a new Agent that another Agent uses is refused (NameTaken)
with free alternatives; it is never silently duplicated.

Generated nicknames are a first and a last name (1,024). When every one is
taken they go on with a double surname ("Milo Reed-Lane", 31,744 more); only
past those is a name numbered. The lists never change length: an Agent
stored before nicknames were stored is shown the name its ID derives here.
"""
import hashlib
import re
from itertools import chain, islice

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
# Free nicknames offered with a refused one.
ALTERNATIVES = 3


class NameTaken(ValueError):
    """A given nickname another Agent of the space already uses."""

    def __init__(self, alternatives: list[str]):
        super().__init__('another Agent in this personal space already uses this name')
        self.alternatives = alternatives


def agent_display_name(agent_id: str, name: str, display_name: str | None = None):
    if display_name:
        return display_name
    if agent_id == 'fuli-project-coordinator' and name == '项目协调人':
        return 'Orion'
    if not ROLE_NAME.search(name):
        return name
    digest = hashlib.sha256(agent_id.encode()).digest()
    return f'{FIRST_NAMES[digest[0] % len(FIRST_NAMES)]} {LAST_NAMES[digest[1] % len(LAST_NAMES)]}'


def profile_shown_name(agent_id: str, profile: dict) -> str:
    """The name an Agent is shown and called by, from its stored profile
    (profile_json read as a dict): every reader of a stored profile derives
    the shown name here, through agent_display_name."""
    return agent_display_name(agent_id, profile.get('name') or '', profile.get('display_name'))


_GENERATED = re.compile(r'(\S+) ([^\s-]+)(?:-([^\s-]+))?(?: \d+)?')


def is_generated_nickname(name: str) -> bool:
    """Whether a name is one FULI generated (unique_nickname, free_nicknames,
    or derived from an Agent ID before nicknames were stored) rather than one
    a person or a role gave."""
    match = _GENERATED.fullmatch(name.strip())
    return bool(match) and match[1] in FIRST_NAMES and match[2] in LAST_NAMES \
        and (match[3] is None or match[3] in LAST_NAMES)


def title_like(name: str) -> bool:
    """Whether a name reads as a job title ("PPT 专责", "design Agent") rather than a person."""
    return bool(ROLE_NAME.search(name) or JOB_TITLE.search(name))


def unique_nickname(agent_id: str, taken: set[str]) -> str:
    """The first free nickname from the Agent's own place in the list.

    It starts where agent_display_name derives a legacy nickname, so an Agent
    whose derived name is still free gets that name. ``taken`` holds identity keys.
    """
    return free_nicknames(agent_id, taken, 1)[0]


def free_nicknames(agent_id: str, taken: set[str], count: int = ALTERNATIVES) -> list[str]:
    """Up to ``count`` free generated nicknames from the Agent's own place in the
    list, then with a double surname; one numbered nickname only when every
    one of those is taken too."""
    digest = hashlib.sha256(agent_id.encode()).digest()
    start = (digest[0] % len(FIRST_NAMES)) * len(LAST_NAMES) + digest[1] % len(LAST_NAMES)
    second = digest[2] % len(LAST_NAMES)
    names = (_nickname((start + step) % NICKNAMES) for step in range(NICKNAMES))
    longer = (_nickname((start + step) % NICKNAMES, (second + step // NICKNAMES) % len(LAST_NAMES))
              for step in range(NICKNAMES * len(LAST_NAMES)))
    candidates = (name for name in chain(names, longer) if name and identity_key(name) not in taken)
    free = list(islice(candidates, count))
    return free or [_numbered(_nickname(start), taken)]


def new_agent_display_name(agent_id: str, name: str, display_name: str | None, taken: set[str]) -> str:
    """The nickname a new Agent starts with: the display_name given when it reads
    as a person (NameTaken when another Agent already has it), else its role name
    when that reads as a person and is free, otherwise a generated one."""
    given = display_name or name
    if title_like(given):
        return unique_nickname(agent_id, taken)
    if identity_key(given) not in taken:
        return given
    if display_name:
        raise NameTaken(free_nicknames(agent_id, taken))
    return unique_nickname(agent_id, taken)


def _nickname(index: int, second_last: int | None = None) -> str:
    """One generated nickname; None for a double surname that repeats itself."""
    last = LAST_NAMES[index % len(LAST_NAMES)]
    if second_last is not None:
        if LAST_NAMES[second_last] == last:
            return None
        last = f'{last}-{LAST_NAMES[second_last]}'
    return f'{FIRST_NAMES[index // len(LAST_NAMES)]} {last}'


def _numbered(name: str, taken: set[str]) -> str:
    number = 2
    while True:
        suffix = f' {number}'
        candidate = name[:NAME_LIMIT - len(suffix)].rstrip() + suffix
        if identity_key(candidate) not in taken:
            return candidate
        number += 1
