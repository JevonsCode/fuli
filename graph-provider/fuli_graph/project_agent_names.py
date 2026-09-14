"""Stable product nicknames, independent of identity, assignment and work status."""
import hashlib
import re


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


def agent_display_name(agent_id: str, name: str, display_name: str | None = None):
    if display_name:
        return display_name
    if agent_id == 'fuli-project-coordinator' and name == '项目协调人':
        return 'Orion'
    if not ROLE_NAME.search(name):
        return name
    digest = hashlib.sha256(agent_id.encode()).digest()
    return f'{FIRST_NAMES[digest[0] % len(FIRST_NAMES)]} {LAST_NAMES[digest[1] % len(LAST_NAMES)]}'
