# DingDong 系统划词

这是一个原生 macOS 菜单栏工具。在任意支持辅助功能选区的应用里选中文字，会出现“复制 / 翻译 / 解释”工具条；`⌥⌘C` 是不依赖浮层的系统复制快捷键。

浏览器页面仍保留为插件清单与权限路由示例，但不再代表可安装产品。真正的系统级实现位于 `macos/`。

## 安装

```sh
cd examples/dingdong-selection-plugin
macos/scripts/validate.sh
macos/scripts/memory-check.sh
macos/scripts/install-app.sh
```

应用安装到用户的 `Applications` 目录，并以菜单栏 `D◉` 运行。首次启动需要在“系统设置 → 隐私与安全性 → 辅助功能”允许“DingDong Selection”；这是读取其他应用当前选区所必需的 macOS 权限。

## 使用

1. 在任意应用里选中文字。
2. 点击浮动工具条的“复制 / 翻译 / 解释”；或按 `⌥⌘C` 直接复制。
3. 从菜单栏 `D◉ → 模型后端` 选择 Provider，再用“模型设置…”修改服务地址、模型、输出语言和 token。

应用不保存选中文字。工具条关闭或命令开始后，内存里的选区立即清空；复制不会调用模型；只有点击“翻译/解释”才会发送文本。

## 模型后端

| 后端 | 默认值 | Token | 内存策略 |
| --- | --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` / `qwen3:0.6b` | 不需要 | 请求带 `keep_alive: 0`，响应后立即卸载 |
| LM Studio | `http://127.0.0.1:1234/v1` | 本机默认不需要 | 在 LM Studio 开启 JIT 自动卸载 |
| OpenRouter | `https://openrouter.ai/api/v1` / `openrouter/free` | 需要自己的 key | 云端推理，不占本机模型内存 |
| Gemini | 官方 OpenAI-compatible 地址 / Flash 模型 | 需要自己的 key | 云端推理，不占本机模型内存 |

不会下载、共享或内置所谓“网上免费 token”。合法的免费方式是从 Provider 官方控制台生成自己的 key，并遵守其免费额度；免费模型、额度和隐私条款会变化，应以官方页面为准：

- [Ollama 本地 API 与认证](https://docs.ollama.com/api/authentication)
- [Ollama Chat API（`keep_alive`）](https://docs.ollama.com/api/chat)
- [OpenRouter 免费模型路由](https://openrouter.ai/docs/guides/routing/routers/free-router)
- [Gemini 免费层价格](https://ai.google.dev/gemini-api/docs/pricing)
- [LM Studio 本地服务](https://lmstudio.ai/docs/developer/core/server)

## 浏览器插件契约

浏览器示例同时导出可测试的插件契约：清单声明 `selection.read`、`clipboard.write`、
`host.permissions` 和 `model.provider`；运行时通过 `enable`/`disable`（或
`setEnabled`）控制用户开关。禁用时命令在创建宿主能力代理前就返回
`PLUGIN_DISABLED`，不会读取选区、写入剪贴板、读取权限状态或调用模型。

`src/provider-router.js` 提供 OpenAI-compatible、Ollama 和 LM Studio 的统一配置与路由。
云端配置只接受 `keychainTokenRef`，实际 token 由 Keychain 适配器在请求时短暂解析；
普通配置、序列化结果、错误和运行时事件都不会接收或输出 token。Ollama/LM Studio
仅允许本机回环 HTTP；远程端点必须使用 HTTPS。没有 Keychain token 时翻译/解释会以
`PROVIDER_TOKEN_REQUIRED` 明确失败，不会使用或寻找所谓“免费 token”。

云端 token 只存入 macOS Keychain，且使用“仅此设备、解锁时可用”保护；不会进入 UserDefaults、仓库、请求正文、日志或 FULI。本地 Provider 不读取也不发送 Keychain token，并被强制限制在回环地址。非本机地址必须使用 HTTPS；URL 内嵌凭据、查询参数、片段和跨域重定向都会被拒绝。

## 低内存边界

- 原生 AppKit + Swift，无 Electron、Chromium、WebKit、常驻模型或定时轮询。
- 使用 macOS Accessibility 选区变化通知，并保留 `mouseUp`/选区键盘事件作为兼容兜底；全程事件驱动，事件结束后只做一次 30–60ms 合并读取。
- Accessibility 查询在专用串行队列执行，并给目标应用设置 200ms 消息超时；不会阻塞主界面等待失去响应的应用。
- 只有角色和安全子角色可确认的文本控件才允许读取；密码框、未知角色或读取失败都按 fail-closed 拒绝。
- 浮层按需创建、不获取键盘焦点，关闭后释放；网络请求可在新选区、关闭或退出时取消。
- 选区最多 10,000 字符；Provider 响应在下载过程中超过 1 MiB 就取消，结果浮层最多保留 8,000 字符。
- `memory-check.sh` 在 20 秒冷启动稳定期后检查 Release 包：RSS ≤ 45,000 KiB、物理 footprint ≤ 20 MiB、CPU ≤ 1%。可用 `WARMUP_SECONDS` 覆盖稳定期。

## 验证

```sh
macos/scripts/validate.sh
macos/scripts/memory-check.sh
cd macos
DINGDONG_SKIP_PERMISSION_PROMPT=1 \
  './dist/DingDong Selection.app/Contents/MacOS/DingDongSelection' \
  --smoke-test-selection-pipeline
```

最后一条只会在当前 TextEdit 焦点内容以 `DingDong system selection test` 开头时临时改变选区；只有真实的 `kAXSelectedTextChangedNotification` 回调到达、AX 读取成功并显示浮层后才会通过。结束前还会读取验证原选区，并确认原前台应用已恢复；任一步失败都返回非零状态。它不伪装成物理键鼠事件测试。其余验证覆盖 Swift 单元测试、Release 构建、Info.plist、临时签名、禁止重型运行时、系统事件分类、选区释放、Provider 请求、prompt injection 边界、HTTPS/loopback 限制、token header 与 1 MiB 响应上限。

额外的 Swift 6 严格并发检查：

```sh
cd macos
swift build -Xswiftc -swift-version -Xswiftc 6 -Xswiftc -strict-concurrency=complete
```

浏览器权限运行时仍可单独验证：

```sh
nvm use 24.16.0
npm test
npm run validate
```

## 真实性与安全边界

- 默认未安装 Ollama、LM Studio 或模型；选择本地后端不代表本地服务已经存在。
- 默认没有云端 token；测试使用明确的本机替身，不含真实服务结果。
- 某些应用不会通过 Accessibility 暴露选区；`⌥⌘C` 会回退为向前台应用发送标准 `⌘C`。
- 系统剪贴板可能参与 Apple 的通用剪贴板同步；本工具不读取旧剪贴板，也不保存剪贴板历史。
- 浏览器 JavaScript 运行时仍只是可信插件的能力路由示例，不是不可信代码沙箱。
- 不读取 Git 身份、凭据、浏览器 Cookie 或无关文件，不执行 GitLab 操作。
