import ApplicationServices
import Foundation
import SelectionCore

struct SystemSelection: Sendable {
    let text: String
    let bounds: CGRect?
}

final class AccessibilitySelectionReader: @unchecked Sendable {
    private final class ElementBox: @unchecked Sendable {
        let value: AXUIElement

        init(_ value: AXUIElement) {
            self.value = value
        }
    }

    private let queue = DispatchQueue(
        label: "com.dingdong.selection-assistant.accessibility",
        qos: .userInitiated
    )
    private let permissionPort: DingDongPermissionPort
    private let lifecycle: DingDongPluginLifecycle?
    private let requestLock = NSLock()
    private var latestRequestID: UInt64 = 0

    init(
        permissionPort: DingDongPermissionPort,
        lifecycle: DingDongPluginLifecycle? = nil
    ) {
        self.permissionPort = permissionPort
        self.lifecycle = lifecycle
    }

    var isTrusted: Bool {
        permissionPort.status.isGranted
    }

    var canReadSelection: Bool {
        (lifecycle?.isEnabled ?? true) && permissionPort.status.isGranted
    }

    @discardableResult
    func requestAccess(showPrompt: Bool) -> Bool {
        guard lifecycle?.isEnabled ?? true else { return false }
        return permissionPort.requestAccess(showPrompt: showPrompt).isGranted
    }

    func cancelPendingReads() {
        _ = beginRequest()
    }

    func readCurrentSelection(
        completion: @escaping @MainActor @Sendable (SystemSelection?) -> Void
    ) {
        let requestID = beginRequest()
        queue.async { [weak self] in
            guard let self,
                  self.isLatestRequest(requestID),
                  self.canReadSelection else { return }
            let selection = self.readCurrentSelectionSynchronously()
            guard self.isLatestRequest(requestID), self.canReadSelection else { return }
            DispatchQueue.main.async {
                guard self.isLatestRequest(requestID), self.canReadSelection else { return }
                completion(selection)
            }
        }
    }

    func readSelection(
        from element: AXUIElement,
        completion: @escaping @MainActor @Sendable (SystemSelection?) -> Void
    ) {
        let box = ElementBox(element)
        let requestID = beginRequest()
        queue.async { [weak self, box] in
            guard let self,
                  self.isLatestRequest(requestID),
                  self.canReadSelection else { return }
            let selection = self.selection(from: box.value)
            guard self.isLatestRequest(requestID), self.canReadSelection else { return }
            DispatchQueue.main.async {
                guard self.isLatestRequest(requestID), self.canReadSelection else { return }
                completion(selection)
            }
        }
    }

    private func beginRequest() -> UInt64 {
        requestLock.lock()
        defer { requestLock.unlock() }
        latestRequestID &+= 1
        return latestRequestID
    }

    private func isLatestRequest(_ requestID: UInt64) -> Bool {
        requestLock.lock()
        defer { requestLock.unlock() }
        return requestID == latestRequestID
    }

    private func readCurrentSelectionSynchronously() -> SystemSelection? {
        guard canReadSelection else { return nil }

        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, 0.2)
        var applicationValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide,
            kAXFocusedApplicationAttribute as CFString,
            &applicationValue
        ) == .success,
        let applicationValue,
        CFGetTypeID(applicationValue) == AXUIElementGetTypeID() else { return nil }
        let application = unsafeDowncast(applicationValue, to: AXUIElement.self)
        AXUIElementSetMessagingTimeout(application, 0.2)

        var focusedValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        ) == .success,
        let focusedValue,
        CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else { return nil }

        let focusedElement = unsafeDowncast(focusedValue, to: AXUIElement.self)
        return selection(from: focusedElement)
    }

    private func selection(from focusedElement: AXUIElement) -> SystemSelection? {
        guard canReadSelection else { return nil }
        AXUIElementSetMessagingTimeout(focusedElement, 0.2)
        guard isSafeToRead(focusedElement) else { return nil }

        var selectedValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            focusedElement,
            kAXSelectedTextAttribute as CFString,
            &selectedValue
        ) == .success,
        let selectedText = selectedValue as? String,
        let normalized = SelectionText.normalize(selectedText) else { return nil }

        return SystemSelection(
            text: normalized,
            bounds: selectedTextBounds(for: focusedElement)
        )
    }

    private func isSafeToRead(_ element: AXUIElement) -> Bool {
        var attributeNamesValue: CFArray?
        let attributeListResult = AXUIElementCopyAttributeNames(
            element,
            &attributeNamesValue
        )
        guard attributeListResult == .success,
              let attributeNames = attributeNamesValue as? [String] else {
            return SelectionSecurityPolicy.allowsRead(
                attributeListAvailable: false,
                role: .unknown,
                subroleAdvertised: false,
                subroleReadSucceeded: false,
                isSecureTextField: false
            )
        }

        let roleAdvertised = attributeNames.contains(kAXRoleAttribute as String)
        guard roleAdvertised else {
            return SelectionSecurityPolicy.allowsRead(
                attributeListAvailable: true,
                role: .unknown,
                subroleAdvertised: false,
                subroleReadSucceeded: false,
                isSecureTextField: false
            )
        }

        var roleValue: CFTypeRef?
        let roleResult = AXUIElementCopyAttributeValue(
            element,
            kAXRoleAttribute as CFString,
            &roleValue
        )
        guard roleResult == .success, let role = roleValue as? String else {
            return SelectionSecurityPolicy.allowsRead(
                attributeListAvailable: true,
                role: .unknown,
                subroleAdvertised: false,
                subroleReadSucceeded: false,
                isSecureTextField: false
            )
        }
        let classifiedRole: SelectionElementRole
        if role == (kAXTextAreaRole as String) ||
            role == (kAXStaticTextRole as String) ||
            role == "AXWebArea" {
            classifiedRole = .nonSecretTextContainer
        } else if role == (kAXTextFieldRole as String) {
            classifiedRole = .textField
        } else {
            classifiedRole = .unknown
        }

        let subroleAdvertised = attributeNames.contains(kAXSubroleAttribute as String)
        guard subroleAdvertised else {
            return SelectionSecurityPolicy.allowsRead(
                attributeListAvailable: true,
                role: classifiedRole,
                subroleAdvertised: false,
                subroleReadSucceeded: false,
                isSecureTextField: false
            )
        }

        var subroleValue: CFTypeRef?
        let subroleResult = AXUIElementCopyAttributeValue(
            element,
            kAXSubroleAttribute as CFString,
            &subroleValue
        )
        let subrole = subroleValue as? String
        return SelectionSecurityPolicy.allowsRead(
            attributeListAvailable: true,
            role: classifiedRole,
            subroleAdvertised: true,
            subroleReadSucceeded: subroleResult == .success &&
                SelectionSecurityPolicy.isKnownSubrole(subrole),
            isSecureTextField: subrole == (kAXSecureTextFieldSubrole as String)
        )
    }

    private func selectedTextBounds(for element: AXUIElement) -> CGRect? {
        var rangeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &rangeValue
        ) == .success,
        let rangeValue else { return nil }

        var boundsValue: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXBoundsForRangeParameterizedAttribute as CFString,
            rangeValue,
            &boundsValue
        ) == .success,
        let boundsValue else { return nil }

        guard CFGetTypeID(boundsValue) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(boundsValue, to: AXValue.self)
        guard AXValueGetType(axValue) == .cgRect else { return nil }
        var bounds = CGRect.zero
        return AXValueGetValue(axValue, .cgRect, &bounds) ? bounds : nil
    }
}
