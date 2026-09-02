import AppKit
import ApplicationServices
import SelectionCore

@MainActor
final class SelectionMonitor {
    private var globalMonitor: Any?
    private var accessibilityObserver: AccessibilitySelectionObserver?
    private let permissionPort: DingDongPermissionPort
    private let lifecycle: DingDongPluginLifecycle?
    private var isStarted = false
    private var pendingCapture: DispatchWorkItem?
    private var pendingObservedElement: AXUIElement?
    private var captureSchedule = SelectionCaptureScheduleState()
    private var captureGeneration = LatestRequestGeneration()
    private var selectionEvents = SelectionEventGeneration()
    private let onSelectionChanged: (AXUIElement?) -> Void
    private let onSelectionInvalidated: () -> Void
    private let onDirectCopy: () -> Void

    var isRunning: Bool {
        isStarted && globalMonitor != nil && accessibilityObserver?.isAttached == true
    }

    var selectionNotificationCheckpoint: UInt64 {
        selectionEvents.checkpoint
    }

    func hasObservedSelectionNotification(since checkpoint: UInt64) -> Bool {
        selectionEvents.hasAdvanced(since: checkpoint)
    }

    init(
        onSelectionChanged: @escaping (AXUIElement?) -> Void,
        onSelectionInvalidated: @escaping () -> Void,
        onDirectCopy: @escaping () -> Void,
        permissionPort: DingDongPermissionPort,
        lifecycle: DingDongPluginLifecycle? = nil
    ) {
        self.onSelectionChanged = onSelectionChanged
        self.onSelectionInvalidated = onSelectionInvalidated
        self.onDirectCopy = onDirectCopy
        self.permissionPort = permissionPort
        self.lifecycle = lifecycle
    }

    @discardableResult
    func start() -> Bool {
        guard lifecycle?.isEnabled ?? true else {
            stop()
            return false
        }
        if !isStarted {
            isStarted = true
            installGlobalMonitor()
        }
        guard permissionPort.status.isGranted else { return false }
        installAccessibilityObserver()
        return accessibilityObserver != nil
    }

    /// Keeps the keyboard copy fallback available without starting an
    /// Accessibility observer. It is still stopped with the plugin.
    func startDirectCopyOnly() {
        guard lifecycle?.isEnabled ?? true else {
            stop()
            return
        }
        guard !isStarted else { return }
        isStarted = true
        installGlobalMonitor()
    }

    private func installGlobalMonitor() {
        if globalMonitor == nil {
            let mask = NSEvent.EventTypeMask.leftMouseUp.union(.keyUp)
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
                self?.handle(event)
            }
        }
    }

    private func installAccessibilityObserver() {
        guard accessibilityObserver == nil else { return }
        let observer = AccessibilitySelectionObserver(
            onSelectionChanged: { [weak self] element in
                self?.handleAccessibilitySelectionChange(element)
            },
            onFocusChanged: { [weak self] in
                self?.handleFocusChange()
            },
            permissionPort: permissionPort
        )
        observer.start()
        accessibilityObserver = observer
    }

    func stop() {
        isStarted = false
        cancelPendingSelectionCapture()
        accessibilityObserver?.stop()
        accessibilityObserver = nil
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
    }

    private func handle(_ event: NSEvent) {
        guard isStarted, lifecycle?.isEnabled ?? true else { return }
        let trigger: SelectionTrigger
        switch event.type {
        case .leftMouseUp:
            trigger = .primaryMouseUp
        case .keyUp:
            trigger = .keyUp(
                keyCode: event.keyCode,
                modifiers: SelectionInputModifiers(event.modifierFlags)
            )
        default:
            return
        }

        if trigger.isDirectCopyShortcut {
            cancelPendingSelectionCapture()
            onDirectCopy()
            return
        }
        guard permissionPort.status.isGranted else { return }
        guard trigger.shouldReadSelection else { return }

        scheduleSelectionCapture()
    }

    private func handleAccessibilitySelectionChange(_ element: AXUIElement) {
        guard isStarted,
              lifecycle?.isEnabled ?? true,
              permissionPort.status.isGranted else { return }
        let trigger = SelectionTrigger.accessibilitySelectionChanged
        guard trigger.shouldReadSelection else { return }
        selectionEvents.recordObservedEvent()
        scheduleSelectionCapture(from: element, after: 0.03)
    }

    private func scheduleSelectionCapture(
        from element: AXUIElement? = nil,
        after delay: TimeInterval = 0.06
    ) {
        pendingCapture?.cancel()
        let source: SelectionCaptureSource = element == nil
            ? .focusedApplication
            : .observedElement
        captureSchedule.schedule(source)
        pendingObservedElement = element
        let generation = captureGeneration.advance()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.captureGeneration.isCurrent(generation) else { return }
            guard let scheduledSource = self.captureSchedule.consume() else { return }
            let observedElement = scheduledSource == .observedElement
                ? self.pendingObservedElement
                : nil
            self.pendingObservedElement = nil
            self.pendingCapture = nil
            self.onSelectionChanged(observedElement)
        }
        pendingCapture = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelPendingSelectionCapture() {
        captureGeneration.advance()
        pendingCapture?.cancel()
        pendingCapture = nil
        pendingObservedElement = nil
        captureSchedule.cancel()
    }

    private func handleFocusChange() {
        cancelPendingSelectionCapture()
        onSelectionInvalidated()
    }
}

private extension SelectionInputModifiers {
    init(_ flags: NSEvent.ModifierFlags) {
        var value: SelectionInputModifiers = []
        if flags.contains(.shift) { value.insert(.shift) }
        if flags.contains(.command) { value.insert(.command) }
        if flags.contains(.option) { value.insert(.option) }
        self = value
    }
}
