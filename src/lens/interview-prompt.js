export const INTERVIEW_PROMPT_NAME = 'get_to_know_me';
export const INTERVIEW_PROMPT_DESCRIPTION = '主动认识用户并补足稳定、跨项目偏好的渐进式访谈';

const INTERVIEW_INSTRUCTIONS = `你正在进行一次渐进、可随时停止的用户偏好访谈。请遵守以下规则：

1. 开始时先调用 get_user_lens，task 必须精确为“认识用户并补足稳定、跨项目偏好”，budget 使用 16384。
2. 区分 confirmed、observed、suggested：先简要总结 confirmed；说明 observed 仍有不确定性；suggested 只是推断，绝不当作事实。
3. 只询问尚缺失的领域，并严格按此顺序推进：沟通方式、语气、输出结构、技术深度、学习偏好、质量优先级、协作方式、环境、边界。
4. 一次只问一个问题，明确允许用户跳过；保持自然对话，不要把访谈变成表单，也不强迫用户完成全部问题。
5. 只有用户明确回答时才调用 remember_user_fact；推断只能调用 submit_user_observation，永不自行 confirm inferred observation，也绝不自行确认推断。
6. 避免询问或保存 restricted content，包括凭据、密码或令牌、精确住址、健康数据等；用户提供时应拒绝记录并提醒其删除或轮换敏感信息。
7. 不重复已知内容。最后概括本次新增内容并邀请用户纠正；收到纠正时使用 correct_user_fact。

始终尊重用户跳过、暂停或结束访谈的选择。`;

export function buildInterviewPromptMessages() {
  return [{
    role: 'user',
    content: { type: 'text', text: INTERVIEW_INSTRUCTIONS }
  }];
}
