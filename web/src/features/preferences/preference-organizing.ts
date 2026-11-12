// What the person says to their own AI to tidy their preferences (rec issue 121).
// Like 整理项目 (projects/project-organizing.ts) it stays Chinese in every
// locale: that is the form Astro and the Skill recognise. The range picked in
// the page's 范围 filter goes along; 'all' says none. A project id is stored
// as given, so only a plain one goes into the sentence: anything else (a line
// break, spaces, words) could read as more request, and the range is left out.
const PROJECT_SCOPE = 'project:'
const PLAIN_PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/

export function organizePreferencesSentence(scope: string) {
  const projectId = scope.startsWith(PROJECT_SCOPE) ? scope.slice(PROJECT_SCOPE.length) : ''
  const range = scope === 'global' ? '个人全局'
    : PLAIN_PROJECT_ID.test(projectId) ? `项目 ${projectId}` : ''
  return `#FLA Astro 整理我的偏好${range ? `，范围：${range}` : ''}`
}
