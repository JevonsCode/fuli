import { PublishRoute } from './models.js';

const PUBLIC_SOURCE_KINDS = new Set(['prd', 'git', 'config', 'docs']);
const PERSONAL_SOURCE_KINDS = new Set(['personal']);
const PERSONAL_MARKERS = [
  '我觉得',
  '我认为',
  '我希望',
  '我想',
  '我打算',
  '我更喜欢',
  '我喜欢',
  '我不喜欢',
  '我的',
  '个人',
  '偏好',
  '判断'
];
const UNCERTAIN_MARKERS = ['可能', '也许', '不确定', '待确认', '以后要', '似乎'];

export function classifyEpisode({ sourceKind, body }) {
  if (PERSONAL_SOURCE_KINDS.has(sourceKind)) {
    return PublishRoute.PERSONAL;
  }

  if (hasAny(body, PERSONAL_MARKERS)) {
    return PublishRoute.PERSONAL;
  }

  if (hasAny(body, UNCERTAIN_MARKERS)) {
    return PublishRoute.CANDIDATE;
  }

  if (PUBLIC_SOURCE_KINDS.has(sourceKind) && looksLikeFact(body)) {
    return PublishRoute.PUBLIC;
  }

  return PublishRoute.CANDIDATE;
}

function looksLikeFact(body) {
  return (
    body.includes(':') ||
    body.includes('：') ||
    body.includes('=>') ||
    /https?:\/\//.test(body) ||
    looksLikeForbiddenRule(body)
  );
}

function looksLikeForbiddenRule(body) {
  return body
    .split(/\r?\n/)
    .some((line) =>
      /^(?:这个项目|本项目|项目)?\s*(?:禁止|不要|不允许)\s*(?:使用|采用|引入|用)?\s*\S+/.test(
        line.trim()
      )
    );
}

function hasAny(body, markers) {
  return markers.some((marker) => body.includes(marker));
}
