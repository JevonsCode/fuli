import AppKit
import ApplicationServices
import SelectionCore

private final class ObservedElementBox: @unchecked Sendable {
    let value: AXUIElement

    init(_ value: AXUIElement) {
        self.value = value
    }
}

private final class ObserverBox: @unchecked Sendable {
    let value: AXObserver

    init(_ value: AXObserver) {
        self.value = value
    }
}

private func selectionObserverCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else { return }
    let target = Unmanaged<AccessibilitySelectionObserver>
        .fromOpaque(refcon)
        .takeUnretainedValue()
    let notificationName = notification as String
    let elementBox = ObservedElementBox(element)
    let observerBox = ObserverBox(observer)

    // This observer's run-loop source is installed only on the main run loop.
    MainActor.assumeIsolated {
        target.handle(
            observerBox.value,
            notificationName: notificationName,
            element: elementBox.value
        )
    }
}

@MainActor
final class AccessibilitySelectionObserver: NSObject {
    private let onSelectionChanged: (AXUIElement) -> Void
    private let onFocusChanged: () -> Void
    private let permissionPort: DingDongPermissionPort
    private let lifecycle: DingDongPluginLifecycle?
    private var observer: AXObserver?
    private var observedApplication: AXUIElement?
    private var observedElement: AXUIElement?
    private var observedPID: pid_t?
    private var isStarted = false

    var isAttached: Bool {
        observer != nil && observedApplication != nil && observedElement != nil
    }

    init(
        onSelectionChanged: @escaping (AXUIElement) -> Void,
        onFocusChanged: @escaping () -> Void,
        permissionPort: DingDongPermissionPort,
        lifecycle: DingDongPluginLifecycle? = nil
    ) {
        self.onSelectionChanged = onSelectionChanged
        self.onFocusChanged = onFocusChanged
        self.permissionPort = permissionPort
        self.lifecycle = lifecycle
    }

    func start() {
        guard !isStarted else { return }
        guard allowsSelectionObservation else { return }
        isStarted = true
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(applicationDidActivate),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        attachToFrontmostApplication()
    }

    func stop() {
        guard isStarted else { return }
        isStarted = false
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        detach()
    }

    @objc private func applicationDidActivate(_ notification: Notification) {
        onFocusChanged()
        attachToFrontmostApplication()
    }

    fileprivate func handle(
        _ callbackObserver: AXObserver,
        notificationName: String,
        element: AXUIElement
    ) {
        guard isStarted,
              allowsSelectionObservation,
              let observer,
              CFEqual(observer, callbackObserver) else { return }
        if notificationName == kAXFocusedUIElementChangedNotification ||
            notificationName == kAXFocusedWindowChangedNotification {
            onFocusChanged()
            observeFocusedElement()
        } else if notificationName == kAXSelectedTextChangedNotification {
            guard let observedElement,
                  CFEqual(observedElement, element) else { return }
            onSelectionChanged(element)
        }
    }

    private func attachToFrontmostApplication() {
        guard allowsSelectionObservation,
              let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              pid != ProcessInfo.processInfo.processIdentifier,
              pid != observedPID else { return }

        detach()

        var createdObserver: AXObserver?
        let createResult = AXObserverCreate(pid, selectionObserverCallback, &createdObserver)
        guard createResult == .success,
              let createdObserver else { return }

        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.2)
        let context = Unmanaged.passUnretained(self).toOpaque()
        let focusResult = AXObserverAddNotification(
            createdObserver,
            application,
            kAXFocusedUIElementChangedNotification as CFString,
            context
        )
        guard focusResult == .success else { return }

        _ = AXObserverAddNotification(
            createdObserver,
            application,
            kAXFocusedWindowChangedNotification as CFString,
            context
        )
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(createdObserver),
            .commonModes
        )
        observer = createdObserver
        observedApplication = application
        observedPID = pid
        observeFocusedElement()
    }

    private func observeFocusedElement() {
        guard let observer, let application else { return }
        let context = Unmanaged.passUnretained(self).toOpaque()

        if let observedElement {
            AXObserverRemoveNotification(
                observer,
                observedElement,
                kAXSelectedTextChangedNotification as CFString
            )
            self.observedElement = nil
        }

        var focusedValue: CFTypeRef?
        let focusedResult = AXUIElementCopyAttributeValue(
            application,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        )
        guard focusedResult == .success,
        let focusedValue,
        CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else { return }

        let focusedElement = unsafeDowncast(focusedValue, to: AXUIElement.self)
        let selectionResult = AXObserverAddNotification(
            observer,
            focusedElement,
            kAXSelectedTextChangedNotification as CFString,
            context
        )
        guard selectionResult == .success else { return }
        observedElement = focusedElement
    }

    private func detach() {
        guard let observer else {
            observedApplication = nil
            observedElement = nil
            observedPID = nil
            return
        }

        if let observedElement {
            AXObserverRemoveNotification(
                observer,
                observedElement,
                kAXSelectedTextChangedNotification as CFString
            )
        }
        if let observedApplication {
            AXObserverRemoveNotification(
                observer,
                observedApplication,
                kAXFocusedUIElementChangedNotification as CFString
            )
            AXObserverRemoveNotification(
                observer,
                observedApplication,
                kAXFocusedWindowChangedNotification as CFString
            )
        }
        CFRunLoopRemoveSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .commonModes
        )
        self.observer = nil
        observedApplication = nil
        observedElement = nil
        observedPID = nil
    }

    private var application: AXUIElement? {
        observedApplication
    }

    private var allowsSelectionObservation: Bool {
        (lifecycle?.isEnabled ?? true) && permissionPort.status.isGranted
    }
}
