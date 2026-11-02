import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  // Closing the window only hides it (DesktopWindow): FULI keeps running in the
  // menu bar, and 退出 there (or Quit in the Dock menu) quits it (Jevons 11-02).
  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return false
  }

  // Clicking the Dock icon while the window is hidden brings it back.
  override func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag {
      for window in sender.windows where window.canBecomeMain {
        window.makeKeyAndOrderFront(self)
      }
      sender.activate(ignoringOtherApps: true)
    }
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}
