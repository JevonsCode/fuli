import { ProviderRequestError } from '../graphiti/provider-client.js';

// Only this first, read-only lookup can be deferred before a scope is known.
// Each real HTTP attempt is bounded; writes and later handoff operations are
// never retried here or mistaken for a compatibility failure.
export async function lookupTranscriptTask(application, input, sourceApplication) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const task = await application.personal.currentTaskContext({
        personal_space_id: application.config.personal.spaceId,
        session_id: input.session_id, source_application: sourceApplication
      }, { timeoutMs: 1500 });
      if (task !== null && (!task || typeof task !== 'object' || Array.isArray(task)
        || typeof task.token !== 'string' || !task.token
        || !Object.hasOwn(task, 'project_agent_id')
        || (task.project_agent_id !== null && (typeof task.project_agent_id !== 'string'
          || !task.project_agent_id || typeof task.personal_project_id !== 'string' || !task.personal_project_id))
        || (task.session_id !== undefined && task.session_id !== input.session_id)
        || (task.source_application !== undefined && task.source_application !== sourceApplication)
        || (task.personal_space_id !== undefined && task.personal_space_id !== application.config.personal.spaceId))) {
        throw new ProviderRequestError('Current task response does not match its requested scope', { code: 'provider_invalid_response' });
      }
      return { task };
    } catch (error) {
      if (!(error instanceof ProviderRequestError)) throw error;
      if (error.status === 404 && error.code === 'provider_error'
        && error.diagnostic?.status === 404 && error.diagnostic.detail === 'Not Found') {
        return { failure: { status: 'unsupported', entryBlocked: true,
          code: 'current_task_endpoint_unavailable',
          reason: 'Visible transcript synchronization is not available on this Fuli provider version' } };
      }
      const transient = ['provider_unavailable', 'provider_timeout'].includes(error.code)
        || (error.code === 'provider_http_5xx' && [502, 503, 504].includes(error.status));
      if (!transient) throw error;
      if (attempt === 1) return { failure: { status: 'unsaved', entryBlocked: true,
        code: 'current_task_lookup_unavailable',
        reason: 'Visible transcript synchronization is temporarily unavailable after bounded retries; native history remains available for a later verified task entry' } };
    }
  }
}
