# Windows 真机验收清单

给真实 Windows 测试机：每次装上新版本跑一遍，结果按文末格式回复（与 macOS 清单 JevonsCode/rec#40 同一格式）。发现问题另开 issue，标签 `WIN USE ISSUE`。

安装与目录约定见 [docs/windows-first-install.md](../docs/windows-first-install.md)。能自动检查的部分由 `acceptance/windows-tray.js` 完成（见 C 节），这里只列需要人看、需要点的步骤。

## 安全约定（必须遵守）

- 标 🧪 的步骤会改写、卸载或回滚，**只在测试机或测试账户上做**，不要在日常使用的电脑上做。
- 不在验收里删除 `%LOCALAPPDATA%\Fuli`。卸载会保留它；需要空数据时换一个 Windows 测试账户。
- 不用管理员权限，不改系统端口保留（`netsh ... add/delete excludedportrange`）；端口只用 `show` 读。
- 回报里**不要贴**：知识/偏好正文、真实对话、密钥/token、个人或公司身份。日志只贴相关几行，用户名替换成 `<user>`。

下文 `FL` 指已安装 FULI 的命令行（不改 PATH，在 cmd 里运行）：

```
"%LOCALAPPDATA%\Programs\Fuli\FuliNode.exe" src\cli.js
```

例如 `FL status --json` 即 `"%LOCALAPPDATA%\Programs\Fuli\FuliNode.exe" src\cli.js status --json`。

## A. 每次更新必跑（约 15 分钟）

1. **从官方包安装或更新**：从 GitHub Release 下载 `FULI-Setup-<版本>.exe`（或 `fuli-windows-tray-<版本>.zip`），先和同名 `.sha256` 对比。双击 Setup → 「安装 / Install」；SmartScreen 提示时选「更多信息」→「仍要运行」。已装旧版时它走更新：数据保留，客户端关闭后重新打开。
2. **首次打开**：桌面和开始菜单各有一个 FULI 快捷方式；打开后托盘出现 FULI 图标（绿点）。客户端显示「FULI 正常工作」和「已安装 v<版本>」。全新账户上第一次「启动 FULI」才创建 `%LOCALAPPDATA%\Fuli`。
3. **桌面客户端**：
   - 再次双击快捷方式不会开第二个客户端，而是把已有窗口带到前面。
   - 托盘菜单：打开控制台、停止 FULI、启动 FULI、重启 FULI、换一个端口、开机时启动、导出诊断包、退出。逐个点（换端口见 A5），每个动作有进行中的提示和结果。
   - 「退出」只关客户端，FULI 服务继续运行；「停止 FULI」后状态变「FULI 没有运行」。
   - 「开机时启动」默认开；注销再登录后托盘图标自动出现，关掉后不再出现。
   - 在「运行」（Win+R）里输入 `fuli://status`，客户端窗口出现；`fuli://knowledge` 在浏览器打开控制台的知识页（地址是当前端口）。
4. **控制台在配置的端口上**：`FL status --json` 中服务为运行、给出的控制台地址可在浏览器打开；`http://127.0.0.1:<端口>/api/health` 返回 `"service":"fuli-local-console"` 且版本与安装一致。默认端口 2727；改过端口的以 `FL status --json` 为准。
5. **端口保留处理**：
   - `netsh interface ipv4 show excludedportrange protocol=tcp` 记下保留段（只读）。FULI 的端口落在保留段里或被别的程序占用时，启动应自动换端口，客户端提示「端口 X 被系统保留 / 被别的程序占用，FULI 已自动改用 Y」，不需要人做什么。
   - 托盘「换一个端口」：提示「正在换端口并重启 FULI…」，完成后控制台在新端口打开；已打开的 Agent 会话提示重开即可。`FL status --json` 显示新端口。
6. **接入 Claude Code / Codex / OpenCode**：控制台「设置 → 接入」（`/connections`）三者都显示已接入；配置里的命令是 `FuliNode.exe`，不含 `versions\` 版本目录。各新开一个会话问一句与已有项目相关的问题，确认出现 FULI 入口上下文（回复末尾有 FULI 回执）。只有「已接入」不算通过，要看到这一轮真的调用成功。
7. **模型页**：控制台「模型」（`/models`）能打开，列出各角色的模型后端；配置了自己模型的角色，`FL models check <角色>` 返回连接正常（只做合成检查，不发真实内容）。
8. **主要页面**：首页、知识、对话、项目、Agents、收件箱、设置逐一打开，无报错、无空白、窄窗口无横向滚动。
9. **数据格式**：更新前后各跑一次 `FL migrate status --json`；有 pending 时运行 `FL migrate preview` 把步骤 ID 贴回来，**不要**自行 apply。

## B. 首次或大版本时跑（🧪 测试机）

10. 🧪 **从旧版更新（托盘包）**：装上一个旧版本，下载新版 tray zip 并解压到短路径（如 `C:\fuli-new`，路径 ≤ 80 字符），运行其中的 `Update-Fuli.cmd`。客户端关闭后以新版本重新打开；开机启动项、`fuli://` 和 Agent 配置都指向新版本；数据不丢。
11. 🧪 **从客户端一键更新**：在旧版本上等客户端提示「FULI 有新版本 v…」，点「更新到 v…」。依次出现下载、校验、关闭客户端、安装的提示，最后「已更新到 v…」；同版本时提示「没有需要安装的新版本，FULI 没有停止」。
12. 🧪 **回滚**：运行已安装目录里的 `Rollback-Fuli.cmd`，回到上一个版本，客户端以旧版本重新打开、数据仍在。若更新时 Neo4j 升过补丁版本，回滚到更低版本应被拒绝并说明原因。
13. 🧪 **卸载**：在「设置 → 应用 → 已安装的应用」里卸载 FULI（或运行 `Uninstall-Fuli.cmd`）。客户端关闭且不再打开；快捷方式、开机启动项、`fuli://` 关联、已安装应用条目都被移除；`%LOCALAPPDATA%\Fuli` 保留。再运行 Setup 应接上原数据（「已有数据」被沿用）。
14. 🧪 **数据目录权限**：`icacls "%LOCALAPPDATA%\Fuli"` 只有当前用户和 SYSTEM；体检不报 `data_dir_shared`。

## C. 自动检查（开发机，合成数据）

`acceptance/windows-tray.js` 对一个本地或 CI 构建的托盘目录做以下检查，不碰日常安装与真实数据：

```
set FULI_DATA_DIR=<一个空的临时目录>
node acceptance/windows-tray.js --bundle <托盘目录>
```

- 全部文件哈希；`Fuli.exe`、`client\FULI.exe` 是 x64 GUI 程序，`FuliNode.exe` 是控制台程序并能跑本包的 CLI。
- 首次/重复启动只用包内程序、外部候选数据目录和自有进程；控制台在配置端口上应答 `/api/health`，版本与进程都对得上。
- 停止再启动后，合成知识仍可检索；停止释放全部端口与进程。
- 控制台端口被别的程序占用：启动仍成功，控制台换到附近可用端口并保存，在新端口应答；停止不动那个程序。
- 本机存在 Windows 保留端口段时，把控制台端口放进去：启动把它移出保留段并保存，停止后端口全部释放；没有保留段则记为 SKIP。
- 日常安装、Agent 配置文件、进程和端口前后不变。

候选数据目录（`tray-config.json` 里的 `dataDir`）必须不存在；跑完后删掉它。

## 回报格式（每个版本一条评论）

```
🪟[WIN] <版本号>  更新时间 <YYYY-MM-DD HH:mm>  安装方式 Setup / tray zip
| 项 | 结果 | 备注 |
|---|---|---|
| A1 | PASS / FAIL / SKIP | 一句话 |
| … | … | … |
端口：控制台 <端口>；保留段命中 无 / <段>
迁移：pending = 无 / <步骤 ID 列表>
新开的 WIN USE ISSUE：#xx, #yy
```

**WIN USE ISSUE 的内容**：版本号与安装方式；步骤（尽量可复现）；期望 vs 实际；`FL status --json` 与 `FL migrate status --json` 的相关部分；客户端「导出诊断包」或日志相关几行（已去掉个人信息）；截图可选（不能含真实知识或对话内容）。
