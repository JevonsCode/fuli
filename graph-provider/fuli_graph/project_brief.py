"""Read-time, deterministic drafts for old projects; never writes or calls a model."""
import re

from .models import ProjectBriefDraft

BRIEF_LIMIT = 240


async def legacy_project_brief(store, project):
    profile = project.profile
    if profile.has_brief:
        return project
    for source in profile.sources:
        if re.fullmatch(r'readme(?:\.[\w-]+)*', source.title, re.IGNORECASE):
            text = _excerpt(source.summary)
            if text:
                return _draft(project, text, 'readme')
    # Project-scoped and earliest first: a recent Agent's task is not the
    # project's origin. A missing title leaves the brief honestly empty.
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
              [:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {personal_project_id: $project_id})
        WHERE task.title IS NOT NULL AND trim(task.title) <> ''
        RETURN task.title AS title
        ORDER BY task.created_at, task.task_id LIMIT 1
        ''',
        personal_space_id=project.personal_space_id,
        project_id=project.project_id,
        routing_='r',
    )
    text = _excerpt(rows[0]['title']) if rows else ''
    return _draft(project, text, 'first_task') if text else project


def _excerpt(value):
    return ' '.join((value or '').split())[:BRIEF_LIMIT]


def _draft(project, text, source):
    # The existing purpose editor can save/replace this draft. Keeping it in
    # the read projection does not grant a reader write authority or silently
    # convert generated evidence into a confirmed purpose.
    return project.model_copy(update={'profile': project.profile.model_copy(update={
        'purpose': text, 'brief_draft': ProjectBriefDraft(source=source),
    })})
