"""Which Agents of a space share a name, who keeps it, and what the others become.

Before FULI stored a nickname for every Agent (0.20) an Agent's shown name was
derived from its ID, and a name checked before a write could race another
write, so a long-used space can hold FLAs that share a name. Nothing renames
them by itself: the FLAs page lists every shared name with this plan, the
person changes who keeps a name or leaves a rename out, and one click settles
the rest (store_project_agent_name_fixes.py).

Who keeps a name, in order (RULES): a built-in role (it still answers to its
built-in name after a rename, so that name counts as its too); an FLA not
dismissed; one that is not a test FLA; one whose name a person gave it (a
rename in its history, or a name FULI does not generate); one that works in
some project other than a temporary or conversation one (a lead FULI hired
for such a scope gives way); the one with more work (tasks it took part in,
hiring tasks left out, and task entries it worked); the one active most
recently; the one hired first. The others get a free generated name.
"""
from dataclasses import dataclass, field

from .name_identity import identity_key
from .project_agent_models import NameFixGroup, NameFixMember
from .project_agent_names import free_nicknames
from .store_project_agent_naming import SYSTEM_NAMED
from .system_agents import SYSTEM_PROFILES

RULES = ('built_in_role', 'dismissed', 'test', 'person_named', 'temporary_lead', 'less_work', 'less_recent',
         'later')


@dataclass(frozen=True)
class NameHolder:
    """What the plan reads of one Agent."""
    agent_id: str
    name: str
    status: str = 'active'
    test: bool = False
    person_named: bool = False
    # Works only in temporary or conversation projects (and in at least one).
    temporary_only: bool = False
    work: int = 0
    recent: float = 0.0
    created: float = 0.0
    projects: tuple[str, ...] = ()
    names: frozenset[str] = field(default=frozenset())

    @property
    def standing(self) -> tuple:
        """Smaller keeps the name; one entry per rule in RULES."""
        return (self.agent_id not in SYSTEM_NAMED, self.status == 'archived', self.test, not self.person_named,
                self.temporary_only, -self.work, -self.recent, (self.created, self.agent_id))


def called_by(agent_id: str, shown: str) -> frozenset[str]:
    """Every name an Agent is called by: a role's built-in one too."""
    keys = {identity_key(shown)}
    if agent_id in SYSTEM_PROFILES:
        keys.add(identity_key(SYSTEM_PROFILES[agent_id]().name))
    return frozenset(keys - {''})


def shared_names(holders: list[NameHolder]) -> dict[str, list[NameHolder]]:
    """Each name two or more Agents are called by, with those Agents."""
    by_name: dict[str, list[NameHolder]] = {}
    for holder in holders:
        for key in holder.names:
            by_name.setdefault(key, []).append(holder)
    return {key: group for key, group in by_name.items() if len(group) > 1}


def name_fix_plan(holders: list[NameHolder], keep: frozenset[str] = frozenset()) -> list[NameFixGroup]:
    """Every shared name and how it would be settled. ``keep`` names Agents the
    person chose to keep their names; a built-in role always keeps its own.
    New names are free across the whole space and stay the same whichever
    renames the person then leaves out."""
    taken = set().union(*(holder.names for holder in holders)) if holders else set()
    groups, giving_way = [], set()
    for key, group in sorted(shared_names(holders).items()):
        ranked = sorted(group, key=lambda holder: holder.standing)
        chosen = next((holder for holder in ranked if holder.agent_id in keep), None)
        keeper = ranked[0] if ranked[0].agent_id in SYSTEM_NAMED or chosen is None else chosen
        members = [_member(keeper, keeps=True)]
        for holder in ranked:
            if holder is keeper or holder.agent_id in SYSTEM_NAMED or holder.agent_id in giving_way:
                continue
            giving_way.add(holder.agent_id)
            new_name = free_nicknames(holder.agent_id, taken, 1)[0]
            taken.add(identity_key(new_name))
            members.append(_member(holder, keeps=False, new_name=new_name, gave_way='person_chose'
                                   if keeper is chosen and keeper is not ranked[0] else _lost_on(holder, keeper)))
        if len(members) > 1:
            groups.append(NameFixGroup(name=keeper.name, members=members))
    return groups


def _lost_on(holder: NameHolder, keeper: NameHolder) -> str:
    return next((rule for rule, mine, theirs in zip(RULES, holder.standing, keeper.standing) if mine != theirs),
                'later')


def _member(holder: NameHolder, *, keeps: bool, new_name: str | None = None, gave_way: str | None = None):
    return NameFixMember(agent_id=holder.agent_id, name=holder.name, status=holder.status,
                         projects=list(holder.projects), keeps=keeps, new_name=new_name, gave_way=gave_way)
