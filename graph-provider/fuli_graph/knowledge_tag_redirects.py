"""Where a merged tag's word leads now (rec#5 G4-5).

A person's merge leaves the merged tag in place with a redirect to the tag it
went into; it never resolves as a live tag again. Every reader of a tag ID or a
word follows the redirect to the live tag it means now, so an Agent holding an
old ID or typing the old word lands on the merged-into tag. A redirect that
ends at a retired tag means nothing any more. A merge only goes into a tag of
the same namespace or a personal one, so the target is visible wherever the
merged tag was.
"""
from .knowledge_tag_models import LIVE_STATUSES

# Merges into a tag that is merged later chain; the chain is short in practice
# and bounded here so a damaged graph cannot loop.
MAX_REDIRECTS = 32


async def live_target(reader, tag: dict | None) -> dict | None:
    """The live tag `tag` means now: itself, or where its merges lead."""
    for _ in range(MAX_REDIRECTS):
        if tag is None or tag['status'] != 'merged':
            break
        tag = await reader.get_any(tag.get('merged_into_id'))
    return tag if tag is not None and tag['status'] in LIVE_STATUSES else None
