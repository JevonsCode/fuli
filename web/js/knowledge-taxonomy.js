export const QUADRANT_LABELS = Object.freeze({
  known_known: '已知的已知',
  known_unknown: '已知的未知',
  unknown_known: '未知的已知',
  unknown_unknown: '未知的未知'
});

export const QUADRANT_DESCRIPTIONS = Object.freeze({
  known_known: '被明确表达出来的知识或结论',
  known_unknown: '被明确提出、但仍在等待答案的问题',
  unknown_known: '从行为、案例、反馈或反应中提炼出的隐性知识',
  unknown_unknown: '在探索过程中发现、仍需判断的潜在盲点'
});

export const EPISTEMIC_STATUS_LABELS = Object.freeze({
  confirmed: '旧版确认标记',
  observed: '旧版观察标记',
  exploratory: '旧版探索标记'
});

export const CONFIRMATION_STATUS_LABELS = Object.freeze({
  confirmed: '已确认',
  pending: '待确认'
});

export const PROFILE_ASPECT_LABELS = Object.freeze({
  taste: '品味',
  personality: '个性',
  judgment_preference: '判断偏好'
});

export function quadrantLabel(value) {
  return QUADRANT_LABELS[value] ?? value ?? QUADRANT_LABELS.known_known;
}

export function profileAspectLabel(value) {
  return PROFILE_ASPECT_LABELS[value] ?? value ?? '';
}
