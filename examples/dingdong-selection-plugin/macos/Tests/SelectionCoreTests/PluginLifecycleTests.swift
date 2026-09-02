import XCTest
@testable import SelectionCore

final class PluginLifecycleTests: XCTestCase {
    func testPluginIsEnabledByDefaultAndCanBeDisabledAndReenabled() {
        let lifecycle = DingDongPluginLifecycle()

        XCTAssertEqual(lifecycle.state, .enabled)
        XCTAssertTrue(lifecycle.isEnabled)

        lifecycle.disable()

        XCTAssertEqual(lifecycle.state, .disabled)
        XCTAssertFalse(lifecycle.isEnabled)

        lifecycle.enable()

        XCTAssertEqual(lifecycle.state, .enabled)
        XCTAssertTrue(lifecycle.isEnabled)
    }

    func testDisabledPluginDoesNotStartSelectionMonitorOrReadPermission() {
        let permission = TestPermissionPort(status: .granted)
        let host = TestHostCapability(permissionPort: permission)
        let lifecycle = DingDongPluginLifecycle(initialState: .disabled)
        var starts = 0
        var stops = 0
        let runtime = DingDongPluginRuntime(
            lifecycle: lifecycle,
            host: host,
            onStart: { starts += 1 },
            onStop: { stops += 1 }
        )

        XCTAssertFalse(runtime.start())
        XCTAssertFalse(runtime.isRunning)
        XCTAssertEqual(starts, 0)
        XCTAssertEqual(stops, 0)
        XCTAssertFalse(runtime.allowsSelectionRead)
        XCTAssertFalse(runtime.allowsModelCall)
        XCTAssertEqual(permission.statusReads, 0)
        XCTAssertEqual(permission.requestCount, 0)
        XCTAssertEqual(runtime.requestPermission(showPrompt: true), .denied)
        XCTAssertEqual(permission.requestCount, 0)
    }

    func testPermissionGateStartsOnlyWithHostPermissionAndStopsOnDisable() {
        let permission = TestPermissionPort(status: .denied)
        let host = TestHostCapability(permissionPort: permission)
        let lifecycle = DingDongPluginLifecycle()
        var starts = 0
        var stops = 0
        let runtime = DingDongPluginRuntime(
            lifecycle: lifecycle,
            host: host,
            onStart: { starts += 1 },
            onStop: { stops += 1 }
        )

        XCTAssertFalse(runtime.start())
        XCTAssertFalse(runtime.isRunning)
        XCTAssertEqual(starts, 0)
        XCTAssertEqual(permission.statusReads, 1)
        XCTAssertFalse(runtime.allowsSelectionRead)
        XCTAssertFalse(runtime.allowsModelCall)

        permission.status = .granted
        XCTAssertTrue(runtime.start())
        XCTAssertTrue(runtime.isRunning)
        XCTAssertEqual(starts, 1)

        runtime.disable()

        XCTAssertEqual(runtime.state, .disabled)
        XCTAssertFalse(runtime.isRunning)
        XCTAssertEqual(stops, 1)
    }

    func testPermissionRequestIsDelegatedToHostPortAndCanStartPlugin() {
        let permission = TestPermissionPort(status: .denied, requestResult: .granted)
        let host = TestHostCapability(permissionPort: permission)
        let lifecycle = DingDongPluginLifecycle(initialState: .disabled)
        var starts = 0
        let runtime = DingDongPluginRuntime(
            lifecycle: lifecycle,
            host: host,
            onStart: { starts += 1 },
            onStop: {}
        )

        runtime.enable()
        XCTAssertFalse(runtime.isRunning)

        XCTAssertEqual(runtime.requestPermission(showPrompt: true), .granted)
        XCTAssertEqual(permission.requestCount, 1)
        XCTAssertEqual(permission.lastPrompt, true)
        XCTAssertTrue(runtime.isRunning)
        XCTAssertEqual(starts, 1)
    }
}

private final class TestPermissionPort: DingDongPermissionPort {
    private var storedStatus: DingDongPermissionStatus
    var requestResult: DingDongPermissionStatus
    private(set) var statusReads = 0
    private(set) var requestCount = 0
    private(set) var lastPrompt: Bool?

    var status: DingDongPermissionStatus {
        get {
            statusReads += 1
            return storedStatus
        }
        set {
            storedStatus = newValue
        }
    }

    init(
        status: DingDongPermissionStatus,
        requestResult: DingDongPermissionStatus? = nil
    ) {
        self.storedStatus = status
        self.requestResult = requestResult ?? status
    }

    @discardableResult
    func requestAccess(showPrompt: Bool) -> DingDongPermissionStatus {
        requestCount += 1
        lastPrompt = showPrompt
        status = requestResult
        return status
    }
}

private final class TestHostCapability: DingDongHostCapability {
    let permissionPort: DingDongPermissionPort

    init(permissionPort: DingDongPermissionPort) {
        self.permissionPort = permissionPort
    }
}
