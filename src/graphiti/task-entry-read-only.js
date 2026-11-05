import { getCollaborationPreferences } from './collaboration-preference-workflow.js';
import { resolvePreferenceProject } from './preference-project-resolution.js';

// While a graph format step waits for the person the graph is read-only, and a
// task lives in the graph, so no task can begin. The graph stays read-only: a
// write in the old format is what the wait protects against. What an Agent needs
// from the entry is all reads, though, so it keeps the person's preferences and
// recall, records nothing, and says why instead of failing.
export const READ_ONLY_REASON = 'data_format_read_only';
const GUIDANCE = 'FULI is waiting for the person to confirm a data format update, so this task is not recorded. '
  + 'Reads and searches work; saving knowledge is refused until then. There is no task token, so make no checkpoint. '
  + 'Tell the person once to confirm it in the FULI console under Settings, Data format. / '
  + 'FULI 的数据格式更新在等用户确认，这次任务不会被记录。读取和搜索照常，保存知识会被拒绝。没有任务 token，不用 checkpoint。'
  + '请告诉用户一次：到 FULI 控制台的「设置 › 数据格式」确认。';

export const isReadOnlyRefusal = error => error?.code === READ_ONLY_REASON;
export const readOnlyLifecycle = () => ({ status: 'not_started', reason: READ_ONLY_REASON, guidance: GUIDANCE });

export async function readOnlyTaskEntry(application, { personalProjectId = null, projectPath, taskPrompt = null, sessionId = null,
  sourceSessionId = null, sourceApplication = null, projectAgentId = null, workKind = null, workflow = null }) {
  const projectResolution = await resolvePreferenceProject(application, { personalProjectId, projectPath });
  const preferences = await getCollaborationPreferences(application, projectResolution,
    { projectAgentId, taskPrompt, sessionId, sourceSessionId, workKind, workflow, sourceApplication }, () => {});
  return { context: { personal_space_id: application.config.personal.spaceId, personal_project_id: projectResolution.personalProjectId ?? null },
    effective_preferences: preferences.effective_preferences, scope_unknown: preferences.scope_unknown,
    ...(preferences.task_knowledge_recall ? { task_knowledge_recall: preferences.task_knowledge_recall } : {}),
    checkpoint_required: false, task_lifecycle: readOnlyLifecycle() };
}
