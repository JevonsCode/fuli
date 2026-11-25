// Project histories, project policies and the local board have independent sources.
// A task entry, hook, search or other mixed graph query can include the host's
// habits or roster. Keep that copy on disk but stop serving it after a denial.
export function globalCopyRefusal(host, original = host) {
  if (original?.fingerprint !== host?.fingerprint || original?.pairedAt !== host?.pairedAt) {
    return { code: 'pairing_changed', message: '配对已变更，请重试。 / The pairing changed. Try again.' };
  }
  const at = host?.globalDeniedAt ?? host?.revokedAt;
  if (!at) return null;
  return { code: 'global_copy_access_ended', at,
    message: `主机在 ${at} 停止提供全局副本。这个操作需要主机的全局资料；恢复权限并同步后可继续。\nGlobal copy access ended at ${at}. Restore permission on the host and sync to use this operation.` };
}

const projectTools = new Set(['get_project_agent_coordination_policy', 'update_project_agent_coordination_policy',
  'list_project_agent_tasks', 'view_project_agent_task']);

export function needsGlobalCopy(call, routes) {
  const project = call.input?.personalProjectId;
  return !projectTools.has(call.tool) || typeof project !== 'string' || !routes.routedHere('project:' + project);
}

export function localGraphRequestNeedsGlobal(url, method, localIds) {
  if (method !== 'GET') return true;
  if (url.pathname === '/api/personal-projects' || /^\/api\/personal-projects\/[^/]+\/history$/.test(url.pathname)) return false;
  const project = url.searchParams.get('personalProjectId');
  return !localIds.includes(project) || !['/api/project-agent-coordination-policy', '/api/project-agent-tasks'].includes(url.pathname);
}
