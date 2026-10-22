"""The person's tag governance through the Provider routes on the in-memory port
(knowledge_tag_memory.py); test_knowledge_tags_neo4j.py runs the same scenarios
on a disposable Neo4j."""
import pytest

from knowledge_tag_governance_scenarios import GOVERNANCE_SCENARIOS
from knowledge_tag_memory import memory_world


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario', GOVERNANCE_SCENARIOS, ids=lambda scenario: scenario.__name__)
async def test_tag_governance_scenario(scenario):
    async with memory_world() as world:
        await scenario(world)
