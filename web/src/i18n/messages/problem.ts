// When something does not work (features/problem): a page-sized problem
// state, and the prompt the person copies for their own AI to look into it.
export const problemMessages = {
  'zh-CN': {
    copy: '复制给 AI 修复',
    copied: '已复制',
    copyFailed: '没能复制',
    retry: '重新读取',
    errorDetails: '错误信息',
    serviceDown: {
      title: '本机服务还没准备好',
      detail: 'FULI 刚启动或正在更新时会这样，通常一会儿就好。',
    },
    timeout: {
      title: '读取超时',
      detail: '本机服务回应得太慢了。稍等一下再读取一次。',
    },
    failed: {
      title: '这部分暂时读不到',
      detail: '重新读取一次；还不行的话，把问题复制给 AI 看看。',
    },
    notJson: '本机服务没有返回数据（收到的是网页）。FULI 可能正在启动或更新。',
    prompt: {
      intro: '我在用 FULI（本机的 AI 知识与协作工具）时遇到了问题，请帮我看看。',
      what: '现象：{text}',
      where: '页面：{text}',
      error: '错误信息：{text}',
      version: 'FULI 版本：{text}',
      service: '本机服务：{text}',
      ready: '已就绪',
      notReady: '未就绪',
      steps: '请按这个顺序处理：',
      step1: '1. 先到 {issues} 搜索这个错误，看看是不是已知问题；有现成的解决办法就照着做。',
      step2: '2. 找出原因。FULI 控制台右上角的「有 N 件事需要你」和 /api/system/doctor 会列出它自己发现的问题。',
      step3: '3. 好修的（比如重启 FULI、重新连接客户端、更新到新版）就直接修好，告诉我你做了什么。',
      step4: '4. 不好修的，先问我愿不愿意在 GitHub 上提一个 issue；我同意后再帮我起草，不要附带我的个人数据、本机路径或对话内容。',
    },
  },
  'en-US': {
    copy: 'Copy for AI to fix',
    copied: 'Copied',
    copyFailed: 'Could not copy',
    retry: 'Read again',
    errorDetails: 'Error details',
    serviceDown: {
      title: 'The local service is not ready yet',
      detail: 'This happens while FULI starts or updates; it is usually back in a moment.',
    },
    timeout: {
      title: 'Reading timed out',
      detail: 'The local service answered too slowly. Wait a moment and read again.',
    },
    failed: {
      title: 'This part cannot be read right now',
      detail: 'Read it again; if it still fails, copy the problem for your AI to look at.',
    },
    notJson: 'The local service sent a web page instead of data. FULI may be starting or updating.',
    prompt: {
      intro: 'I ran into a problem using FULI (a local AI knowledge and collaboration tool). Please help me look into it.',
      what: 'What happened: {text}',
      where: 'Page: {text}',
      error: 'Error: {text}',
      version: 'FULI version: {text}',
      service: 'Local service: {text}',
      ready: 'ready',
      notReady: 'not ready',
      steps: 'Please go in this order:',
      step1: '1. Search {issues} for this error first to see whether it is a known problem; if it has a fix, follow it.',
      step2: '2. Find the cause. The console\'s "things need you" chip in the top bar and /api/system/doctor list what FULI found itself.',
      step3: '3. If it is easy to fix (restart FULI, reconnect a client, update to the new version), fix it and tell me what you did.',
      step4: '4. If it is not, first ask me whether I want to open a GitHub issue; only after I agree, draft it, without my personal data, local paths or conversations.',
    },
  },
} as const
