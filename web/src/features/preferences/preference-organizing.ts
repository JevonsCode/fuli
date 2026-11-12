// What the person says to their own AI to tidy their preferences (rec issue 121).
// Like 整理项目 (projects/project-organizing.ts) it stays Chinese in every
// locale: that is the form Astro and the Skill recognise. The range picked in
// the page's 范围 filter goes along; 'all' says none.
const PROJECT_SCOPE = 'project:'

export function organizePreferencesSentence(scope: string) {
  const range = scope === 'global' ? '个人全局'
    : scope.startsWith(PROJECT_SCOPE) ? `项目 ${scope.slice(PROJECT_SCOPE.length)}` : ''
  return `#FLA Astro 整理我的偏好${range ? `，范围：${range}` : ''}`
}
