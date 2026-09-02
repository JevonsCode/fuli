import AppKit
import Darwin

@main
enum DingDongSelectionMain {
    @MainActor
    private static var retainedDelegate: AppDelegate?

    @MainActor
    static func main() {
        if CommandLine.arguments.contains("--print-accessibility-status") {
            let host = SystemDingDongHostCapability()
            print(host.permissionPort.status.isGranted ? "trusted" : "not_trusted")
            return
        }
        let application = NSApplication.shared
        let host = SystemDingDongHostCapability()
        let delegate = AppDelegate(hostCapability: host)
        retainedDelegate = delegate
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
        if CommandLine.arguments.contains("--smoke-test-selection-pipeline") {
            exit(delegate.smokeTestExitCode)
        }
    }
}
