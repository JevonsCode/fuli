import Foundation

/// The user-controlled lifecycle state of the native selection plugin.
public enum DingDongPluginState: String, Codable, Equatable, Sendable {
    case enabled
    case disabled

    public var isEnabled: Bool {
        self == .enabled
    }
}

/// Accessibility permission as reported by the DingDong host.
public enum DingDongPermissionStatus: String, Equatable, Sendable {
    case granted
    case denied

    public var isGranted: Bool {
        self == .granted
    }

    /// A readable alias for callers that use the macOS terminology.
    public static var authorized: Self {
        .granted
    }
}

/// The single host-owned permission boundary used by a selection plugin.
///
/// Implementations belong to the DingDong host. The plugin only queries the
/// status and delegates explicit permission requests; it never creates a
/// second authorization identity of its own.
public protocol DingDongPermissionPort: AnyObject {
    var status: DingDongPermissionStatus { get }

    @discardableResult
    func requestAccess(showPrompt: Bool) -> DingDongPermissionStatus
}

public extension DingDongPermissionPort {
    var permissionStatus: DingDongPermissionStatus {
        status
    }

    @discardableResult
    func requestPermission(showPrompt: Bool) -> DingDongPermissionStatus {
        requestAccess(showPrompt: showPrompt)
    }
}

/// Host capabilities injected into a native selection plugin.
public protocol DingDongHostCapability: AnyObject {
    var permissionPort: DingDongPermissionPort { get }
}

public extension DingDongHostCapability {
    var permission: DingDongPermissionPort {
        permissionPort
    }

    var permissions: DingDongPermissionPort {
        permissionPort
    }
}

/// Mutable public state for a user-controlled plugin.
public final class DingDongPluginLifecycle: @unchecked Sendable {
    public private(set) var state: DingDongPluginState

    public var isEnabled: Bool {
        state.isEnabled
    }

    public var isDisabled: Bool {
        !isEnabled
    }

    public var enabled: Bool {
        get { isEnabled }
        set { setEnabled(newValue) }
    }

    public init(initialState: DingDongPluginState = .enabled) {
        state = initialState
    }

    public convenience init(enabled: Bool) {
        self.init(initialState: enabled ? .enabled : .disabled)
    }

    public func enable() {
        state = .enabled
    }

    public func disable() {
        state = .disabled
    }

    public func setEnabled(_ enabled: Bool) {
        if enabled {
            enable()
        } else {
            disable()
        }
    }
}

/// Coordinates the plugin lifecycle with the host permission boundary.
///
/// `onStart` is called only when the plugin is enabled and the host reports
/// granted permission. `onStop` is called when a running plugin is disabled.
/// The callbacks are intentionally small so AppKit observers can be installed
/// and removed without introducing a timer or a resident worker.
public final class DingDongPluginRuntime: @unchecked Sendable {
    public let lifecycle: DingDongPluginLifecycle
    public let host: DingDongHostCapability

    private let onStart: () -> Void
    private let onStop: () -> Void
    private(set) public var isRunning = false

    public var state: DingDongPluginState {
        lifecycle.state
    }

    public var isEnabled: Bool {
        lifecycle.isEnabled
    }

    public var isDisabled: Bool {
        !isEnabled
    }

    public var enabled: Bool {
        get { isEnabled }
        set { setEnabled(newValue) }
    }

    public var permissionStatus: DingDongPermissionStatus {
        host.permissionPort.status
    }

    /// Whether the plugin may issue an Accessibility selection read.
    public var allowsSelectionRead: Bool {
        lifecycle.isEnabled && host.permissionPort.status.isGranted
    }

    /// Model work is gated by the same lifecycle and host permission boundary.
    public var allowsModelCall: Bool {
        allowsSelectionRead
    }

    public var canReadSelection: Bool {
        allowsSelectionRead
    }

    public var canCallModel: Bool {
        allowsModelCall
    }

    public init(
        lifecycle: DingDongPluginLifecycle = DingDongPluginLifecycle(),
        host: DingDongHostCapability,
        onStart: @escaping () -> Void,
        onStop: @escaping () -> Void
    ) {
        self.lifecycle = lifecycle
        self.host = host
        self.onStart = onStart
        self.onStop = onStop
    }

    /// Starts the observer/monitor only when both lifecycle and host gates pass.
    @discardableResult
    public func start() -> Bool {
        guard allowsSelectionRead else {
            stop()
            return false
        }
        guard !isRunning else { return true }
        onStart()
        isRunning = true
        return true
    }

    @discardableResult
    public func startIfPermitted() -> Bool {
        start()
    }

    public func stop() {
        guard isRunning else { return }
        isRunning = false
        onStop()
    }

    public func enable() {
        lifecycle.enable()
        _ = start()
    }

    public func disable() {
        lifecycle.disable()
        stop()
    }

    public func setEnabled(_ enabled: Bool) {
        if enabled {
            enable()
        } else {
            disable()
        }
    }

    /// Delegates the request to the host and retries startup if enabled.
    @discardableResult
    public func requestPermission(showPrompt: Bool = true) -> DingDongPermissionStatus {
        guard lifecycle.isEnabled else { return .denied }
        let status = host.permissionPort.requestAccess(showPrompt: showPrompt)
        _ = start()
        return status
    }
}

public typealias SelectionPluginState = DingDongPluginState
public typealias SelectionPluginLifecycle = DingDongPluginLifecycle
public typealias SelectionPluginRuntime = DingDongPluginRuntime
public typealias DingDongSelectionPlugin = DingDongPluginRuntime
