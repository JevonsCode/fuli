// A prompt that says a kept fact changed ("the channel moved", "now deploys
// to X, not the region recorded earlier", 改成). In the rec#63 eval the model
// captured the new statement beside the old one, so both stayed current.
// Detected only on the prompt, so ordinary tasks carry no extra entry text.
const UPDATE_REQUEST = new RegExp('(?:\\bmoved\\b|\\binstead of\\b|\\bno longer\\b|\\bcorrection\\b|\\bcorrected\\b'
  + '|\\bnot the (?:\\w+ ){0,3}(?:recorded|remembered|stored|old|previous)|\\bchanged (?:to|from)\\b|\\bhas changed\\b'
  + '|\\bupdate (?:what is remembered|the (?:project )?knowledge|the (?:stored|remembered|recorded)\\b)'
  + '|改成|改为|换成|换到|搬到|不再|更正|纠正|已经变|变成了)', 'iu');
export const UPDATE_GUIDANCE = 'The user says something kept may have changed: find the current item with search_current_project_knowledge and revise it with revise_personal_knowledge (action update); capture a new item only when none matches, so the old one does not stay current beside it.';

export function updateRequested(taskPrompt) {
  return typeof taskPrompt === 'string' && UPDATE_REQUEST.test(taskPrompt);
}
