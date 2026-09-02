import AppKit
import SelectionCore

@MainActor
final class FloatingToolbarController: NSObject {
    var onAction: ((SelectionAction) -> Void)?
    var onDismiss: (() -> Void)?

    private var panel: NSPanel?
    private var dismissWorkItem: DispatchWorkItem?
    private var anchor = NSPoint.zero
    private var resultText: String?
    private let clipboard = ClipboardService()

    var isVisible: Bool {
        panel?.isVisible == true
    }

    func showActions(near point: NSPoint) {
        anchor = point
        resultText = nil
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 246, height: 48))
        let actions: [(String, SelectionAction)] = [
            ("复制", .copy),
            ("翻译", .translate),
            ("解释", .explain)
        ]
        for (index, item) in actions.enumerated() {
            let button = NSButton(
                title: item.0,
                target: self,
                action: #selector(actionPressed(_:))
            )
            button.bezelStyle = .rounded
            button.tag = index
            button.frame = NSRect(x: 8 + index * 79, y: 8, width: 72, height: 32)
            content.addSubview(button)
        }
        present(content: content, size: content.frame.size, autoDismissAfter: 8)
    }

    func showLoading(_ title: String) {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: 56))
        let spinner = NSProgressIndicator(frame: NSRect(x: 16, y: 18, width: 20, height: 20))
        spinner.style = .spinning
        spinner.startAnimation(nil)
        content.addSubview(spinner)
        let label = NSTextField(labelWithString: title)
        label.frame = NSRect(x: 48, y: 17, width: 196, height: 22)
        content.addSubview(label)
        present(content: content, size: content.frame.size, autoDismissAfter: nil)
    }

    func showResult(title: String, text: String) {
        resultText = String(text.prefix(8_000))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 238))

        let heading = NSTextField(labelWithString: title)
        heading.font = .systemFont(ofSize: 14, weight: .semibold)
        heading.frame = NSRect(x: 16, y: 204, width: 388, height: 22)
        content.addSubview(heading)

        let scroll = NSScrollView(frame: NSRect(x: 16, y: 52, width: 388, height: 144))
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let textView = NSTextView(frame: scroll.bounds)
        textView.string = resultText ?? ""
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 4, height: 4)
        scroll.documentView = textView
        content.addSubview(scroll)

        let copy = NSButton(title: "复制结果", target: self, action: #selector(copyResult))
        copy.bezelStyle = .rounded
        copy.frame = NSRect(x: 228, y: 12, width: 88, height: 30)
        content.addSubview(copy)
        let close = NSButton(title: "关闭", target: self, action: #selector(closePressed))
        close.bezelStyle = .rounded
        close.frame = NSRect(x: 324, y: 12, width: 80, height: 30)
        content.addSubview(close)

        present(content: content, size: content.frame.size, autoDismissAfter: 30)
    }

    func showTransient(_ message: String) {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 210, height: 48))
        let label = NSTextField(labelWithString: message)
        label.alignment = .center
        label.frame = NSRect(x: 12, y: 14, width: 186, height: 22)
        content.addSubview(label)
        present(content: content, size: content.frame.size, autoDismissAfter: 1.2)
    }

    func dismiss() {
        dismissWorkItem?.cancel()
        dismissWorkItem = nil
        resultText = nil
        panel?.orderOut(nil)
        panel?.contentView = nil
        panel = nil
        onDismiss?()
    }

    @objc private func actionPressed(_ sender: NSButton) {
        let action: SelectionAction
        switch sender.tag {
        case 0: action = .copy
        case 1: action = .translate
        default: action = .explain
        }
        onAction?(action)
    }

    @objc private func copyResult() {
        if let resultText { clipboard.write(resultText) }
        showTransient("结果已复制")
    }

    @objc private func closePressed() {
        dismiss()
    }

    private func present(content: NSView, size: NSSize, autoDismissAfter delay: TimeInterval?) {
        dismissWorkItem?.cancel()
        panel?.orderOut(nil)

        let panel = ActionPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .popUpMenu
        panel.isOpaque = false
        panel.backgroundColor = .windowBackgroundColor
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.contentView = content
        panel.contentView?.wantsLayer = true
        panel.contentView?.layer?.cornerRadius = 11
        panel.contentView?.layer?.masksToBounds = true
        panel.setFrameOrigin(constrainedOrigin(for: size))
        panel.orderFrontRegardless()
        self.panel = panel

        if let delay {
            let work = DispatchWorkItem { [weak self] in self?.dismiss() }
            dismissWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    private func constrainedOrigin(for size: NSSize) -> NSPoint {
        let preferred = NSPoint(x: anchor.x + 10, y: anchor.y - size.height - 10)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) }) ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return preferred }
        return NSPoint(
            x: min(max(preferred.x, visible.minX + 8), visible.maxX - size.width - 8),
            y: min(max(preferred.y, visible.minY + 8), visible.maxY - size.height - 8)
        )
    }
}

@MainActor
private final class ActionPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
