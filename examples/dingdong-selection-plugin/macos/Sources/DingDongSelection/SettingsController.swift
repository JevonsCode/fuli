import AppKit
import SelectionCore

struct SettingsResult {
    let configuration: ModelConfiguration
    let token: String?
    let clearToken: Bool
}

@MainActor
final class SettingsController {
    func present(
        configuration: ModelConfiguration,
        tokenExists: Bool
    ) -> SettingsResult? {
        let alert = NSAlert()
        alert.messageText = "模型设置"
        alert.informativeText = providerDescription(configuration.provider)
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")

        let endpoint = NSTextField(string: configuration.baseURL.absoluteString)
        let model = NSTextField(string: configuration.model)
        let targetLanguage = NSTextField(string: configuration.targetLanguage)
        let token = NSSecureTextField(string: "")
        token.placeholderString = tokenExists ? "已保存在钥匙串；留空保持不变" : "云端 Provider 的 API token"
        let unload = NSButton(checkboxWithTitle: "本地模型请求后立即卸载", target: nil, action: nil)
        unload.state = configuration.unloadLocalModelAfterResponse ? .on : .off
        unload.isEnabled = configuration.provider == .ollama
        let clear = NSButton(checkboxWithTitle: "删除当前 Provider 已保存的 token", target: nil, action: nil)
        clear.isEnabled = tokenExists

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 440, height: 216)
        addRow(label: "服务地址", control: endpoint, to: stack)
        addRow(label: "模型", control: model, to: stack)
        addRow(label: "输出语言", control: targetLanguage, to: stack)
        addRow(label: "Token", control: token, to: stack)
        stack.addArrangedSubview(unload)
        stack.addArrangedSubview(clear)
        alert.accessoryView = stack

        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        guard let baseURL = URL(string: endpoint.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            showError("服务地址无效。")
            return nil
        }

        let updated = ModelConfiguration(
            provider: configuration.provider,
            baseURL: baseURL,
            model: model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
            targetLanguage: targetLanguage.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
            unloadLocalModelAfterResponse: unload.state == .on
        )
        let newToken = token.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return SettingsResult(
            configuration: updated,
            token: newToken.isEmpty ? nil : newToken,
            clearToken: clear.state == .on
        )
    }

    func showError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "无法保存"
        alert.informativeText = message
        alert.runModal()
    }

    private func addRow(label: String, control: NSView, to stack: NSStackView) {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        let fieldLabel = NSTextField(labelWithString: label)
        fieldLabel.alignment = .right
        fieldLabel.frame.size.width = 76
        fieldLabel.widthAnchor.constraint(equalToConstant: 76).isActive = true
        control.widthAnchor.constraint(equalToConstant: 348).isActive = true
        row.addArrangedSubview(fieldLabel)
        row.addArrangedSubview(control)
        stack.addArrangedSubview(row)
    }

    private func providerDescription(_ provider: ModelProviderKind) -> String {
        switch provider {
        case .ollama: return "Ollama 本机 API；不需要 token。"
        case .lmStudio: return "LM Studio 本机 API；模型卸载由 LM Studio 的服务设置管理。"
        case .openRouter: return "OpenRouter 免费路由；需要你自己的 API key。"
        case .gemini: return "Gemini 免费层；需要你自己的 API key。"
        case .openAICompatible: return "自定义 OpenAI-compatible Provider。"
        }
    }
}
