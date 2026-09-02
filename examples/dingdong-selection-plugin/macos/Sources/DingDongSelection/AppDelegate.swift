import AppKit
import SelectionCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let hostCapability: DingDongHostCapability
    private let pluginLifecycle: DingDongPluginLifecycle
    private let selectionReader: AccessibilitySelectionReader
    private let clipboard = ClipboardService()
    private let configurationStore = ConfigurationStore()
    private let tokenStore = KeychainTokenStore()
    private let modelClient: HTTPModelClient
    private let toolbar = FloatingToolbarController()
    private let settingsController = SettingsController()

    private var selectionBuffer = SelectionBuffer()
    private var monitor: SelectionMonitor?
    private var statusItem: NSStatusItem?
    private var permissionItem: NSMenuItem?
    private var pluginToggleItem: NSMenuItem?
    private var providerItems: [NSMenuItem] = []
    private var selectionReadGeneration = 0
    private var modelTask: Task<Void, Never>?
    private var modelRequestGeneration = LatestRequestGeneration()
    private var smokePreviousFrontmostApplication: NSRunningApplication?
    private var smokeFocusedElement: AXUIElement?
    private var smokeOriginalRange: CFRange?
    private var smokeFinishInProgress = false
    private(set) var smokeTestExitCode: Int32 = 0

    private lazy var pluginRuntime: DingDongPluginRuntime = {
        DingDongPluginRuntime(
            lifecycle: pluginLifecycle,
            host: hostCapability,
            onStart: { [weak self] in
                _ = self?.monitor?.start()
            },
            onStop: { [weak self] in
                self?.monitor?.stop()
            }
        )
    }()

    init(
        hostCapability: DingDongHostCapability = SystemDingDongHostCapability(),
        modelClient: HTTPModelClient = HTTPModelClient()
    ) {
        self.hostCapability = hostCapability
        let lifecycle = DingDongPluginLifecycle(
            initialState: configurationStore.loadPluginState()
        )
        self.pluginLifecycle = lifecycle
        self.selectionReader = AccessibilitySelectionReader(
            permissionPort: hostCapability.permissionPort,
            lifecycle: lifecycle
        )
        self.modelClient = modelClient
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureToolbar()
        configureStatusItem()
        monitor = SelectionMonitor(
            onSelectionChanged: { [weak self] element in self?.captureSelection(from: element) },
            onSelectionInvalidated: { [weak self] in self?.invalidateSelection() },
            onDirectCopy: { [weak self] in self?.copyCurrentSelectionDirectly() },
            permissionPort: hostCapability.permissionPort,
            lifecycle: pluginLifecycle
        )
        if !pluginRuntime.start(), pluginRuntime.isEnabled {
            monitor?.startDirectCopyOnly()
        }
        if CommandLine.arguments.contains("--smoke-test-selection-pipeline") {
            smokeTestExitCode = 1
            runSelectionSmokeTest()
        } else if pluginRuntime.isEnabled,
                  ProcessInfo.processInfo.environment["DINGDONG_SKIP_PERMISSION_PROMPT"] != "1",
                  pluginRuntime.permissionStatus == .denied {
            _ = pluginRuntime.requestPermission(showPrompt: true)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        selectionReadGeneration += 1
        cancelModelRequest()
        selectionReader.cancelPendingReads()
        pluginRuntime.stop()
        monitor?.stop()
        toolbar.dismiss()
        selectionBuffer.clear()
    }

    func menuWillOpen(_ menu: NSMenu) {
        permissionItem?.title = pluginRuntime.permissionStatus.isGranted
            ? "辅助功能：已授权"
            : "辅助功能：未授权"
        pluginToggleItem?.state = pluginRuntime.isEnabled ? .on : .off
        pluginToggleItem?.title = pluginRuntime.isEnabled ? "停用划词插件" : "启用划词插件"
        let current = configurationStore.load().provider
        for item in providerItems {
            item.state = provider(for: item.tag) == current ? .on : .off
        }
    }

    private func configureToolbar() {
        toolbar.onAction = { [weak self] action in self?.perform(action) }
        toolbar.onDismiss = { [weak self] in
            self?.selectionBuffer.clear()
            self?.cancelModelRequest()
        }
    }

    private func configureStatusItem() {
        let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "D◉"
        statusItem.button?.toolTip = "DingDong 划词"

        let menu = NSMenu()
        menu.delegate = self
        let pluginToggle = NSMenuItem(
            title: "停用划词插件",
            action: #selector(togglePlugin(_:)),
            keyEquivalent: ""
        )
        pluginToggleItem = pluginToggle
        menu.addItem(pluginToggle)

        let permission = NSMenuItem(title: "辅助功能：检查中", action: nil, keyEquivalent: "")
        permission.isEnabled = false
        permissionItem = permission
        menu.addItem(permission)
        menu.addItem(withTitle: "复制当前选区  ⌥⌘C", action: #selector(copyFromMenu), keyEquivalent: "")
        menu.addItem(withTitle: "请求辅助功能权限", action: #selector(requestPermission), keyEquivalent: "")
        menu.addItem(.separator())

        let providerRoot = NSMenuItem(title: "模型后端", action: nil, keyEquivalent: "")
        let providerMenu = NSMenu()
        let choices: [(String, Int)] = [
            ("Ollama · 本地低内存", 0),
            ("LM Studio · 本地", 1),
            ("OpenRouter · 免费路由", 2),
            ("Gemini · 免费层", 3)
        ]
        providerItems = choices.map { title, tag in
            let item = NSMenuItem(title: title, action: #selector(selectProvider(_:)), keyEquivalent: "")
            item.tag = tag
            providerMenu.addItem(item)
            return item
        }
        providerRoot.submenu = providerMenu
        menu.addItem(providerRoot)
        menu.addItem(withTitle: "模型设置…", action: #selector(openSettings), keyEquivalent: ",")
        menu.addItem(withTitle: "删除当前 Provider token", action: #selector(deleteCurrentToken), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出", action: #selector(quit), keyEquivalent: "q")

        statusItem.menu = menu
        self.statusItem = statusItem
    }

    private func captureSelection(from observedElement: AXUIElement? = nil) {
        guard pluginRuntime.allowsSelectionRead else { return }
        selectionReadGeneration += 1
        let generation = selectionReadGeneration
        let completion: @MainActor @Sendable (SystemSelection?) -> Void = { [weak self] selection in
            guard let self, generation == self.selectionReadGeneration else { return }
            guard let selection else {
                self.selectionBuffer.clear()
                self.toolbar.dismiss()
                return
            }
            self.cancelModelRequest()
            guard self.selectionBuffer.update(selection.text) else { return }
            self.toolbar.showActions(near: self.panelAnchor(from: selection.bounds))
        }
        if let observedElement {
            selectionReader.readSelection(from: observedElement, completion: completion)
        } else {
            selectionReader.readCurrentSelection(completion: completion)
        }
    }

    private func invalidateSelection() {
        selectionReadGeneration += 1
        toolbar.dismiss()
    }

    private func perform(_ action: SelectionAction) {
        guard pluginRuntime.isEnabled else {
            selectionBuffer.clear()
            cancelModelRequest()
            return
        }
        guard let text = selectionBuffer.consume() else {
            toolbar.showTransient("没有可用的选区")
            return
        }

        if action == .copy {
            cancelModelRequest()
            if clipboard.write(text) {
                toolbar.showTransient("已复制到剪贴板")
            } else {
                toolbar.showResult(title: "复制失败", text: "系统剪贴板暂时不可用。")
            }
            return
        }

        guard pluginRuntime.allowsModelCall else {
            cancelModelRequest()
            return
        }

        let configuration = configurationStore.load()
        let token: String?
        do {
            token = configuration.requiresToken
                ? try tokenStore.load(account: configuration.provider.rawValue)
                : nil
        } catch {
            toolbar.showResult(title: "无法读取 token", text: error.localizedDescription)
            return
        }

        let requestGeneration = cancelModelRequest()
        toolbar.showLoading(action == .translate ? "正在翻译…" : "正在解释…")
        modelTask = Task { [weak self] in
            guard let self else { return }
            guard !Task.isCancelled, self.pluginRuntime.allowsModelCall else { return }
            do {
                let result = try await modelClient.generate(
                    action: action,
                    text: text,
                    configuration: configuration,
                    token: token
                )
                await MainActor.run {
                    guard self.modelRequestGeneration.isCurrent(requestGeneration) else { return }
                    self.modelTask = nil
                    self.toolbar.showResult(
                        title: action == .translate ? "翻译结果" : "解释结果",
                        text: result
                    )
                }
            } catch {
                let wasCancelled = Task.isCancelled || (error as? URLError)?.code == .cancelled
                await MainActor.run {
                    guard self.modelRequestGeneration.isCurrent(requestGeneration) else { return }
                    self.modelTask = nil
                    if wasCancelled {
                        self.toolbar.dismiss()
                    } else {
                        self.toolbar.showResult(title: "操作失败", text: error.localizedDescription)
                    }
                }
            }
        }
    }

    private func copyCurrentSelectionDirectly(allowShortcutFallback: Bool = true) {
        guard pluginRuntime.isEnabled else { return }
        selectionReadGeneration += 1
        cancelModelRequest()
        let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard pluginRuntime.allowsSelectionRead else {
            guard allowShortcutFallback,
                  frontmostPID != nil,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmostPID else {
                toolbar.showResult(title: "复制失败", text: "当前应用没有提供可读取的系统选区。")
                return
            }
            clipboard.sendCopyShortcutToFrontmostApp()
            toolbar.showTransient("已发送系统复制命令")
            return
        }
        selectionReader.readCurrentSelection { [weak self] selection in
            guard let self else { return }
            if let selection, self.clipboard.write(selection.text) {
                self.selectionBuffer.clear()
                self.toolbar.showTransient("已复制到剪贴板")
                return
            }
            guard allowShortcutFallback,
                  frontmostPID != nil,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmostPID else {
                self.toolbar.showResult(title: "复制失败", text: "当前应用没有提供可读取的系统选区。")
                return
            }
            self.clipboard.sendCopyShortcutToFrontmostApp()
            self.toolbar.showTransient("已发送系统复制命令")
        }
    }

    private func panelAnchor(from accessibilityBounds: CGRect?) -> NSPoint {
        guard let bounds = accessibilityBounds,
              let mainHeight = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height else {
            return NSEvent.mouseLocation
        }
        return NSPoint(x: bounds.midX, y: mainHeight - bounds.maxY)
    }

    @objc private func copyFromMenu() {
        copyCurrentSelectionDirectly(allowShortcutFallback: false)
    }

    @objc private func requestPermission() {
        guard pluginRuntime.isEnabled else { return }
        _ = pluginRuntime.requestPermission(showPrompt: true)
    }

    @objc private func togglePlugin(_ sender: NSMenuItem) {
        setPluginEnabled(!pluginRuntime.isEnabled)
    }

    private func setPluginEnabled(_ enabled: Bool) {
        pluginRuntime.setEnabled(enabled)
        configurationStore.savePluginState(pluginRuntime.state)
        if enabled,
           pluginRuntime.permissionStatus == .denied {
            monitor?.startDirectCopyOnly()
            return
        }
        guard !enabled else { return }

        selectionReadGeneration += 1
        cancelModelRequest()
        selectionReader.cancelPendingReads()
        monitor?.stop()
        selectionBuffer.clear()
        toolbar.dismiss()
    }

    @objc private func selectProvider(_ sender: NSMenuItem) {
        let preset: ModelPreset
        switch sender.tag {
        case 0: preset = .ollama
        case 1: preset = .lmStudio
        case 2: preset = .openRouter
        default: preset = .gemini
        }
        do {
            try configurationStore.save(.preset(preset))
        } catch {
            settingsController.showError(error.localizedDescription)
        }
    }

    @objc private func openSettings() {
        let configuration = configurationStore.load()
        let account = configuration.provider.rawValue
        guard let result = settingsController.present(
            configuration: configuration,
            tokenExists: tokenStore.containsToken(account: account)
        ) else { return }

        do {
            try configurationStore.save(result.configuration)
            if result.clearToken {
                try tokenStore.delete(account: account)
            } else if let token = result.token {
                try tokenStore.save(token, account: account)
            }
        } catch {
            settingsController.showError(error.localizedDescription)
        }
    }

    @objc private func deleteCurrentToken() {
        do {
            try tokenStore.delete(account: configurationStore.load().provider.rawValue)
        } catch {
            settingsController.showError(error.localizedDescription)
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func provider(for tag: Int) -> ModelProviderKind {
        switch tag {
        case 0: return .ollama
        case 1: return .lmStudio
        case 2: return .openRouter
        default: return .gemini
        }
    }

    @discardableResult
    private func cancelModelRequest() -> UInt64 {
        let generation = modelRequestGeneration.advance()
        modelTask?.cancel()
        modelTask = nil
        return generation
    }

    private func runSelectionSmokeTest() {
        guard pluginRuntime.isEnabled,
              pluginRuntime.permissionStatus.isGranted else {
            finishSelectionSmokeTest("not_trusted")
            return
        }
        smokePreviousFrontmostApplication = NSWorkspace.shared.frontmostApplication
        guard let textEdit = NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.apple.TextEdit"
        ).first else {
            finishSelectionSmokeTest("textedit_not_running")
            return
        }
        guard textEdit.activate(options: [.activateAllWindows]) else {
            finishSelectionSmokeTest("textedit_activation_failed")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.setKnownTextEditSelection(pid: textEdit.processIdentifier)
        }
    }

    private func setKnownTextEditSelection(pid: pid_t) {
        guard monitor?.isRunning == true else {
            finishSelectionSmokeTest("monitor_not_running")
            return
        }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.2)
        var focusedValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        ) == .success,
        let focusedValue,
        CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
            finishSelectionSmokeTest("focused_element_unavailable")
            return
        }

        let focusedElement = unsafeDowncast(focusedValue, to: AXUIElement.self)
        var textValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            focusedElement,
            kAXValueAttribute as CFString,
            &textValue
        ) == .success,
        let text = textValue as? String,
        text.hasPrefix("DingDong system selection test") else {
            finishSelectionSmokeTest("known_fixture_not_focused")
            return
        }

        var originalRangeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            focusedElement,
            kAXSelectedTextRangeAttribute as CFString,
            &originalRangeValue
        ) == .success,
        let originalRangeValue,
        CFGetTypeID(originalRangeValue) == AXValueGetTypeID() else {
            finishSelectionSmokeTest("original_selection_unavailable")
            return
        }
        let originalAXRange = unsafeDowncast(originalRangeValue, to: AXValue.self)
        guard AXValueGetType(originalAXRange) == .cfRange else {
            finishSelectionSmokeTest("original_selection_invalid")
            return
        }
        var originalRange = CFRange()
        guard AXValueGetValue(originalAXRange, .cfRange, &originalRange) else {
            finishSelectionSmokeTest("original_selection_invalid")
            return
        }
        smokeFocusedElement = focusedElement
        smokeOriginalRange = originalRange

        let observerCheckpoint = monitor?.selectionNotificationCheckpoint ?? 0
        var range = originalRange.location == 0 && originalRange.length == 8
            ? CFRange(location: 9, length: 6)
            : CFRange(location: 0, length: 8)
        guard let rangeValue = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(
                focusedElement,
                kAXSelectedTextRangeAttribute as CFString,
                rangeValue
              ) == .success else {
            finishSelectionSmokeTest("selection_write_failed")
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            guard self.monitor?.hasObservedSelectionNotification(since: observerCheckpoint) == true else {
                self.finishSelectionSmokeTest("observer_notification_not_received")
                return
            }
            self.finishSelectionSmokeTest(self.toolbar.isVisible ? "passed" : "toolbar_not_visible")
        }
    }

    private func finishSelectionSmokeTest(_ result: String) {
        guard !smokeFinishInProgress else { return }
        smokeFinishInProgress = true
        pluginRuntime.stop()
        monitor?.stop()

        var finalResult = result
        if let smokeFocusedElement, var smokeOriginalRange,
           let rangeValue = AXValueCreate(.cfRange, &smokeOriginalRange) {
            let restoreResult = AXUIElementSetAttributeValue(
                smokeFocusedElement,
                kAXSelectedTextRangeAttribute as CFString,
                rangeValue
            )
            let restoredRange = currentSelectionRange(of: smokeFocusedElement)
            if restoreResult != .success ||
                restoredRange?.location != smokeOriginalRange.location ||
                restoredRange?.length != smokeOriginalRange.length {
                finalResult = smokeResult(finalResult, adding: "selection_restore_failed")
            }
        }
        self.smokeFocusedElement = nil
        smokeOriginalRange = nil

        if let previous = smokePreviousFrontmostApplication,
           !previous.isTerminated {
            guard previous.activate(options: [.activateAllWindows]) else {
                completeSelectionSmokeTest(
                    smokeResult(finalResult, adding: "frontmost_restore_activation_failed")
                )
                return
            }
            let expectedPID = previous.processIdentifier
            smokePreviousFrontmostApplication = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                guard let self else { return }
                let restored = NSWorkspace.shared.frontmostApplication?.processIdentifier == expectedPID
                self.completeSelectionSmokeTest(
                    restored
                        ? finalResult
                        : self.smokeResult(finalResult, adding: "frontmost_restore_verification_failed")
                )
            }
            return
        }
        smokePreviousFrontmostApplication = nil

        completeSelectionSmokeTest(finalResult)
    }

    private func currentSelectionRange(of element: AXUIElement) -> CFRange? {
        var rangeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &rangeValue
        ) == .success,
        let rangeValue,
        CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return nil }
        let axRange = unsafeDowncast(rangeValue, to: AXValue.self)
        guard AXValueGetType(axRange) == .cfRange else { return nil }
        var range = CFRange()
        return AXValueGetValue(axRange, .cfRange, &range) ? range : nil
    }

    private func smokeResult(_ result: String, adding restorationFailure: String) -> String {
        result == "passed" ? restorationFailure : "\(result)+\(restorationFailure)"
    }

    private func completeSelectionSmokeTest(_ result: String) {
        smokeTestExitCode = result == "passed" ? 0 : 1
        print("selection_pipeline_smoke_test=\(result)")
        NSApp.terminate(nil)
    }
}
