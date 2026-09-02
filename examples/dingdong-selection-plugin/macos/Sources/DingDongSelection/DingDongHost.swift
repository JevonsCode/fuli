import ApplicationServices
import SelectionCore

/// The host-owned Accessibility capability shared by the native plugin.
///
/// Keeping the system authorization calls here gives the host one permission
/// identity. Reader, observer, and lifecycle code receive this port instead of
/// independently asking macOS for authorization.
final class SystemAccessibilityPermissionPort: DingDongPermissionPort {
    var status: DingDongPermissionStatus {
        AXIsProcessTrusted() ? .granted : .denied
    }

    @discardableResult
    func requestAccess(showPrompt: Bool) -> DingDongPermissionStatus {
        let promptKey = "AXTrustedCheckOptionPrompt"
        let trusted = AXIsProcessTrustedWithOptions(
            [promptKey: showPrompt] as CFDictionary
        )
        return trusted ? .granted : .denied
    }
}

final class SystemDingDongHostCapability: DingDongHostCapability {
    let permissionPort: DingDongPermissionPort

    init(permissionPort: DingDongPermissionPort = SystemAccessibilityPermissionPort()) {
        self.permissionPort = permissionPort
    }
}
