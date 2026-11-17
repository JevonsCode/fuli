"""The four fixed roles' identities, declared once for the Provider.

Jefa, Bole, Tonborg and Astro (the global assistant). Everything in the
Provider names a fixed role through these constants. The Node side declares
the same four in src/employees/fixed-roles.js and the console in
web/src/features/agent-profile/fixed-roles.ts; the three cannot import each
other, so test/fixed-roles-contract.test.js keeps them alike. Imports nothing,
so every module can read it. What each role is and does is system_agents.py.
"""

SYSTEM_COORDINATOR_AGENT_ID = 'employee.jefa'
SYSTEM_HR_AGENT_ID = 'employee.bole'
SYSTEM_JUDGMENT_AGENT_ID = 'employee.tonborg'
SYSTEM_ASSISTANT_AGENT_ID = 'employee.assistant'

SYSTEM_ROLE_AGENT_IDS = (
    SYSTEM_COORDINATOR_AGENT_ID,
    SYSTEM_HR_AGENT_ID,
    SYSTEM_JUDGMENT_AGENT_ID,
    SYSTEM_ASSISTANT_AGENT_ID,
)


def system_role_capability(agent_id: str) -> str:
    """The capability that marks an identity as the Provider's own fixed role."""
    return 'fuli.employee:' + agent_id.removeprefix('employee.')
