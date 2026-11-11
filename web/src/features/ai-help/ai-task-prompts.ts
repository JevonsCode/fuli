// 「让 AI 来做」: the prompt a person copies from a 「?」 and pastes into their
// own Agent (Claude Code, Codex, OpenCode with FULI's MCP connected), which
// then does the job end to end through FULI's own paths:
// run_delegated_action for catalog routes, the named Agent tools, and the
// console's loopback reads. The text addresses the Agent, never the person,
// so it lives here and not among the console's messages (whose rule is that
// the person is never sent to a terminal). test/ai-task-prompts.test.js
// checks every route and tool named here against the interface catalog.
//
// No imports: the node test loads this file as it is.

export type AiTaskId =
  | 'models' | 'settings' | 'capture' | 'clients' | 'update' | 'storage' | 'lan'
  | 'decisions' | 'workbench' | 'knowledge' | 'connections'

export interface AiTaskContext {
  /** This console's origin, e.g. http://127.0.0.1:2828. */
  console: string
  /** The card or page the 「?」 belongs to, as the person sees it. */
  area: string
  /** The model guide on FULI's website, in the console's language. */
  guide: string
}

type Template = (context: AiTaskContext) => string

const COMMON_ZH = (context: AiTaskContext) =>
  `用 FULI 的 MCP 工具（list_agent_interfaces 查工具说明，fuli_call 调用）；控制台在 ${context.console}，只读接口可以直接 GET。`
  + '改动一律走 run_delegated_action（会留下记录和撤销方法）；被拒绝时把原因原样告诉我，不要换别的办法绕过。'
const COMMON_EN = (context: AiTaskContext) =>
  `Use FULI's MCP tools (list_agent_interfaces for a tool's schema, fuli_call to run it); the console is ${context.console} and its read routes answer a plain GET. `
  + 'Make every change with run_delegated_action (it is recorded with its undo); when FULI refuses, tell me its reason as it is and never work around it.'
const BROWSER_ZH = '如果你是浏览器里的 AI，而这个页面提供了 WebMCP 工具（fuli_ 开头），直接用它们做同样的事。'
const BROWSER_EN = 'If you are the AI in my browser and this page offers WebMCP tools (named fuli_…), use them for the same job.'

const ZH: Record<AiTaskId, Template> = {
  models: (c) => [
    '帮我给 FULI 接一个模型，用在：<写上用途，比如 Astro 和 Dreaming / 语义搜索 / Tonborg>。',
    COMMON_ZH(c),
    '1. 先问我用哪个 OpenAI 或 Anthropic 兼容接口、哪个 API Key（我在这句话里点名了就用那个），不要自己去翻环境变量、配置文件或文档找 Key。任何时候都不要打印 Key。',
    `2. 用这个 Key 自己请求接口的模型列表（OpenAI 兼容是 GET <endpoint>/models），按 ${c.guide} 的说明挑一个够用的。`,
    '3. 把 Key 存进 FULI：在终端把 Key 从标准输入传给 fuli models set-key <key 名> --endpoint <endpoint>（例如 printf \'%s\' "$KEY" | fuli models set-key work-openai --endpoint https://api.example.com/v1），不要写进命令参数、文件或输出。FULI 只把这个 Key 发给这个地址；已有的 Key 要换地址，也要这样重新存。没有 fuli 命令就停下，请我在模型页「接入」里粘贴 Key。',
    `4. GET ${c.console}/api/model-backends/roles，记下 revision、要改的角色和它现在的 allowedOperations。`,
    '5. run_delegated_action，route「PUT /api/model-backends/roles/:role」，params { role }（assistant 是 Astro，semantic 是语义搜索，用 openai_embeddings），body：{ revision, connectionId, connection: { protocol, endpoint, model, secretRef }, settings: { enabled: true, allowedOperations, egress: { approvedProjects: [只放我点名的项目], allowUnassigned: false }, budget: {}, fallbackToSession: true } }。',
    '6. run_delegated_action，route「POST /api/model-backends/roles/:role/check」测试；失败就按原因修好再测。最后告诉我接了哪个模型、给谁用、哪些项目的内容会发给它。',
    BROWSER_ZH,
  ].join('\n'),
  settings: (c) => [
    `帮我把 FULI 设置里「${c.area}」改成：<写上你想要的>。`,
    COMMON_ZH(c),
    `先 GET ${c.console}/api/system/settings 看当前值，再用 run_delegated_action 的「PUT /api/system/settings」保存整份 configured（只改我说的字段）。端口、局域网和图谱运行方式要重启，留给我点「应用并重启」。改完再读一遍，告诉我改了什么、怎么改回去。`,
    BROWSER_ZH,
  ].join('\n'),
  capture: (c) => [
    '帮我调整 FULI 记录哪些对话：<写上要记录或不再记录的项目、客户端>。',
    COMMON_ZH(c),
    '先用 get_capture_policy 看现在的设置，再用 update_capture_policy 提出改动，把它返回的预览原样给我看；我同意后，用 run_delegated_action 的「POST /api/capture-changes/:previewId/confirm」确认。最后告诉我现在记录哪些、不记录哪些。',
  ].join('\n'),
  clients: (c) => [
    '帮我把 FULI 接到我电脑上的 AI 客户端：<写上客户端，比如 Claude Code、Codex、OpenCode、Cursor，或「全部」>。',
    COMMON_ZH(c),
    `先 GET ${c.console}/api/system/client-connection/status 看检测到哪些客户端，再用 run_delegated_action 的「POST /api/system/client-connection/connect」逐个接入；体检有问题就用「POST /api/system/doctor/repair」修复。最后告诉我哪些已接好、哪些需要我重开会话。`,
  ].join('\n'),
  update: (c) => [
    '帮我把 FULI 更新到最新版。',
    COMMON_ZH(c),
    `先 GET ${c.console}/api/system/version?fresh=1 看有没有新版本和更新说明，有就用 run_delegated_action 的「POST /api/system/update」更新，等控制台重新响应后告诉我现在的版本和主要变化。`,
  ].join('\n'),
  storage: (c) => [
    '帮我看看 FULI 的旧数据：<写上想做的事，比如占了多少空间 / 恢复某次改动前的设置>。',
    COMMON_ZH(c),
    '用 read_old_data 列出备份和大小；要恢复的，用 run_delegated_action 的「POST /api/old-data/:id/restore」（FULI 会先把现在的状态另存一份，可以再恢复回来）。立即删除旧数据只能我自己在设置里点，你只告诉我删哪些能省多少。',
  ].join('\n'),
  lan: (c) => [
    '帮我设置 FULI 的局域网圆桌：<写上要做的事，比如和另一台电脑配对、共享某个项目>。',
    COMMON_ZH(c),
    '局域网圆桌的操作（「POST /api/peer/join」「PUT /api/peer/shares」等）默认需要我先在 设置 › AI 权限 打开「局域网圆桌」；被拒绝时告诉我去哪里打开，打开后再继续。',
  ].join('\n'),
  decisions: (c) => [
    '帮我处理 FULI「待决策」里等我的事。',
    COMMON_ZH(c),
    '先用 list_agent_attention 和 list_tonborg_questions 读出来，按项目分组、每条一句话告诉我，并给出你的建议。我说了怎么处理之后：要确认的用 run_delegated_action 的「POST /api/knowledge/batch-confirmation」，Tonborg 的问题用「POST /api/judgment/feedback」，都把我的原话放进 personWords；不要的用 revise_personal_knowledge 设为失效，reason 写上我的原话。我没表态的不要动。',
    BROWSER_ZH,
  ].join('\n'),
  workbench: (c) => [
    '帮我看看 FULI 里的 FLA 都在做什么：<写上想知道或想安排的事>。',
    COMMON_ZH(c),
    '用 list_project_agents、list_project_agent_tasks 和 view_project_agent_task 读，按「在做 / 卡住 / 等我」分组告诉我；要派新任务用 submit_project_agent_task，卡住的先看原因再建议怎么解。',
  ].join('\n'),
  knowledge: (c) => [
    '帮我在 FULI 里找：<写上要找的事>。',
    COMMON_ZH(c),
    '用 search_current_project_knowledge（当前项目）或 search_knowledge_graph（全部）查，给出原文和出处；发现过时或错的，用 revise_personal_knowledge 提出修改，确认前先问我。',
    BROWSER_ZH,
  ].join('\n'),
  connections: (c) => [
    '帮我把外部知识接到 FULI：<写上来源，比如 Notion、某个文档目录，以及要放进哪个项目>。',
    COMMON_ZH(c),
    '用 list_external_knowledge_connectors 和 discover_external_knowledge_sources 找到来源，用 create_external_knowledge_binding 绑定到我说的项目，再用 check_external_knowledge_binding 检查、sync_external_knowledge_binding 同步。需要登录或 Key 的，告诉我去哪里拿，不要替我登录。',
  ].join('\n'),
}

const EN: Record<AiTaskId, Template> = {
  models: (c) => [
    'Connect a model to FULI for: <the uses, e.g. Astro and Dreaming / semantic search / Tonborg>.',
    COMMON_EN(c),
    '1. Ask me which OpenAI- or Anthropic-compatible endpoint and API key to use (or use the one I named here); never search environment variables, config files or documents for a key yourself. Never print the key.',
    `2. With that key, list the endpoint's models yourself (OpenAI-compatible: GET <endpoint>/models) and pick one that is enough, following ${c.guide}.`,
    '3. Store the key in FULI: pipe it on stdin into fuli models set-key <key name> --endpoint <endpoint> (e.g. printf \'%s\' "$KEY" | fuli models set-key work-openai --endpoint https://api.example.com/v1); never put it in an argument, a file or any output. FULI sends that key to that address only; moving an existing key to another address means storing it again this way. Without a fuli command, stop and ask me to paste the key in the model page\'s Connect dialog.',
    `4. GET ${c.console}/api/model-backends/roles and note revision, the role to change and its allowedOperations.`,
    '5. run_delegated_action with route "PUT /api/model-backends/roles/:role", params { role } (assistant is Astro; semantic is semantic search and takes openai_embeddings), body: { revision, connectionId, connection: { protocol, endpoint, model, secretRef }, settings: { enabled: true, allowedOperations, egress: { approvedProjects: [only projects I named], allowUnassigned: false }, budget: {}, fallbackToSession: true } }.',
    '6. run_delegated_action with route "POST /api/model-backends/roles/:role/check" to test it; fix and test again on failure. Then tell me which model serves which use and which projects\' content goes to it.',
    BROWSER_EN,
  ].join('\n'),
  settings: (c) => [
    `Change "${c.area}" in FULI's settings to: <what you want>.`,
    COMMON_EN(c),
    `GET ${c.console}/api/system/settings first, then save the whole configured object with run_delegated_action on "PUT /api/system/settings", changing only what I asked. Ports, LAN access and the graph runtime need a restart: leave that to my "Apply and restart". Read it again and tell me what changed and how to change it back.`,
    BROWSER_EN,
  ].join('\n'),
  capture: (c) => [
    'Change which conversations FULI records: <projects or clients to record or stop recording>.',
    COMMON_EN(c),
    'Read the current policy with get_capture_policy, propose the change with update_capture_policy and show me its preview word for word; once I agree, confirm it with run_delegated_action on "POST /api/capture-changes/:previewId/confirm". Then tell me what is recorded now and what is not.',
  ].join('\n'),
  clients: (c) => [
    'Connect FULI to the AI clients on this computer: <clients, e.g. Claude Code, Codex, OpenCode, Cursor, or all>.',
    COMMON_EN(c),
    `GET ${c.console}/api/system/client-connection/status to see what is detected, then connect each with run_delegated_action on "POST /api/system/client-connection/connect"; repair what the doctor reports with "POST /api/system/doctor/repair". Tell me which are connected and which need a new session.`,
  ].join('\n'),
  update: (c) => [
    'Update FULI to the newest version.',
    COMMON_EN(c),
    `GET ${c.console}/api/system/version?fresh=1 for a newer version and its notes; if there is one, run_delegated_action on "POST /api/system/update", wait until the console answers again, and tell me the version now and what changed.`,
  ].join('\n'),
  storage: (c) => [
    'Look at FULI\'s old data: <what you want, e.g. how much space it takes / restore the settings from before a change>.',
    COMMON_EN(c),
    'List backups and sizes with read_old_data; restore one with run_delegated_action on "POST /api/old-data/:id/restore" (FULI keeps the current state first, so it can be restored back). Deleting old data now is mine to click in Settings: only tell me what deleting would free.',
  ].join('\n'),
  lan: (c) => [
    'Set up FULI\'s LAN roundtable: <what to do, e.g. pair with another computer, share a project>.',
    COMMON_EN(c),
    'LAN roundtable changes ("POST /api/peer/join", "PUT /api/peer/shares" and the rest) need me to turn on "LAN roundtable" in Settings › AI permissions first; when refused, tell me where to turn it on and continue after I did.',
  ].join('\n'),
  decisions: (c) => [
    'Help me with what waits for me in FULI\'s inbox (待决策).',
    COMMON_EN(c),
    'Read it with list_agent_attention and list_tonborg_questions, group it by project, one line each, with your suggestion. After I say what to do: confirm with run_delegated_action on "POST /api/knowledge/batch-confirmation" and answer Tonborg\'s questions with "POST /api/judgment/feedback", both with my exact words as personWords; drop with revise_personal_knowledge (invalidate), my words as its reason. Leave what I did not decide.',
    BROWSER_EN,
  ].join('\n'),
  workbench: (c) => [
    'Tell me what my FULI Agents (FLAs) are doing: <what you want to know or arrange>.',
    COMMON_EN(c),
    'Read with list_project_agents, list_project_agent_tasks and view_project_agent_task, grouped as working / blocked / waiting for me; submit new work with submit_project_agent_task, and for a blocked task read why before suggesting a fix.',
  ].join('\n'),
  knowledge: (c) => [
    'Find this in FULI: <what to find>.',
    COMMON_EN(c),
    'Search with search_current_project_knowledge (this project) or search_knowledge_graph (everything) and quote the source; for anything outdated or wrong, propose a change with revise_personal_knowledge and ask me before confirming it.',
    BROWSER_EN,
  ].join('\n'),
  connections: (c) => [
    'Connect external knowledge to FULI: <the source, e.g. Notion or a docs folder, and the project it belongs to>.',
    COMMON_EN(c),
    'Find it with list_external_knowledge_connectors and discover_external_knowledge_sources, bind it to the project I named with create_external_knowledge_binding, then check_external_knowledge_binding and sync_external_knowledge_binding. When it needs a sign-in or key, tell me where to get it; never sign in for me.',
  ].join('\n'),
}

export const AI_TASK_IDS = Object.keys(ZH) as AiTaskId[]

/** The prompt for one job in the console's language ('zh-CN' or anything else for English). */
export function aiTaskPrompt(task: AiTaskId, locale: string, context: AiTaskContext): string {
  return (locale === 'zh-CN' ? ZH : EN)[task](context)
}
