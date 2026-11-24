// 「添加客户端」's prompt (Jevons 11-17): the person copies it into the client
// they want FULI in and sends it as it is. That client's own Agent knows
// where it reads MCP servers from, so it opens this console's add link with
// its name, file and format filled in. Adding stays the person's own step
// (`local_user_only` in the interface catalog): the link only fills the
// dialog, and the person checks it and clicks 添加并接入 on this computer.
// test/ai-friendly-console.test.js checks the link and formats named here.
//
// No imports: the node test loads this file as it is.

/**
 * The MCP file formats a client described by hand can name (agent-installer's write formats):
 * the console's one list, for the prompt and the add dialog's choices.
 */
export const ADD_CLIENT_FORMATS = ['mcp-servers-json', 'opencode-json', 'codex-toml'] as const
export type AddClientFormat = typeof ADD_CLIENT_FORMATS[number]

/** What the add link fills in; nothing is added until the person confirms it. */
export interface AddClientDraft { name: string, mcpFile: string, format: AddClientFormat, skillsDir: string }

// The add link's query keys, beside ?tab=clients.
const NAME = 'addClient'
const FILE = 'mcpFile'
const FORMAT = 'format'
const SKILLS = 'skillsDir'
export const ADD_CLIENT_QUERY_KEYS = [NAME, FILE, FORMAT, SKILLS] as const

/** console: this console's origin, e.g. http://127.0.0.1:2727. */
export function addClientPrompt(locale: string, console: string): string {
  const link = `${console}/settings?tab=clients&${NAME}=<name>&${FILE}=<file>&${FORMAT}=<format>&${SKILLS}=<skills>`
  const formats = ADD_CLIENT_FORMATS.join(' / ')
  if (locale !== 'zh-CN') {
    return [
      'Help me connect FULI to you, the AI client I am using now, so FULI keeps you up to date with my other clients.',
      `1. Find the global configuration file you read MCP servers from at start (under my home folder, not one inside a project) and its format, one of ${formats}; and the global folder you load Skills from (one folder per Skill with its SKILL.md), if you have one. When unsure, check your own official documentation instead of guessing. Do not edit them.`,
      `2. Open this link in my default browser with the system's open command, each value URL-encoded: ${link}. name is your product name, file is that file starting with ~/, format is its format, skills is that Skills folder starting with ~/ (leave it empty if you have none). If you cannot open it, show me the link to click.`,
      '3. Tell me to check the values in FULI and click Add and connect there; FULI backs the file up and keeps my other servers. Then tell me whether you need a restart before FULI\'s tools show up.',
      '4. Once FULI\'s tools show up, check it really works: call FULI\'s get_collaboration_preferences for this request and end your reply with the agent_receipt.markdown it returns (a 「FULI Agent：…」 line). Tools alone are not enough; if no receipt comes back, tell me so.',
    ].join('\n')
  }
  return [
    '帮我把 FULI 接到你自己（我现在用的这个 AI 客户端），让 FULI 以后和我的其他客户端一起替我更新。',
    `1. 找出你启动时读取 MCP 服务器的全局配置文件（在我的主目录下，不是某个项目里的）和它的格式，只能是 ${formats} 之一；如果你支持 Skill，再找出你读取全局 Skill 的文件夹（每个 Skill 一个文件夹，里面有 SKILL.md）。拿不准就查你自己的官方文档，不要猜。这些都不要改。`,
    `2. 用系统的打开命令在我的默认浏览器里打开这个链接，每个值都做 URL 编码：${link}。name 是你的产品名，file 是那个文件（用 ~/ 开头），format 是它的格式，skills 是那个 Skill 文件夹（用 ~/ 开头，没有就留空）。打不开就把链接给我点。`,
    '3. 告诉我在 FULI 里核对这几项，点「添加并接入」；FULI 会先备份这个文件，保留我其他的服务。再告诉我要不要重启你才能用上 FULI 的工具。',
    '4. 能用上 FULI 的工具之后，验收一下：为这次请求调用 FULI 的 get_collaboration_preferences，回复末尾带上它返回的 agent_receipt.markdown（一行「FULI Agent：…」）。只看到工具列表不算接好；拿不到这一行就告诉我。',
  ].join('\n')
}

/** The draft an add link carries, or null when the link is not one. */
export function addClientDraft(query: Record<string, unknown>): AddClientDraft | null {
  const text = (key: string) => (typeof query[key] === 'string' ? (query[key] as string).trim() : '')
  const name = text(NAME)
  const mcpFile = text(FILE)
  if (!name && !mcpFile) return null
  const format = ADD_CLIENT_FORMATS.find((known) => known === text(FORMAT)) ?? 'mcp-servers-json'
  return { name: name.slice(0, 64), mcpFile: mcpFile.slice(0, 1024), format, skillsDir: text(SKILLS).slice(0, 1024) }
}
