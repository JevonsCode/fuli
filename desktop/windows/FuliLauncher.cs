using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

// Fuli.exe at the package root. Shortcuts, the launch-at-login entry and the
// one-click update (src/desktop/windows-desktop-client.js) open this file, also
// from older versions, so it stays at the root while the desktop client lives in
// client\ with its own DLLs and data folder. It only starts that client.
internal static class FuliLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var client = Path.Combine(root, "client", "FULI.exe");
        try
        {
            // --background: started at login, the client shows only its tray icon.
            if (args.Length > 1 || (args.Length == 1 && args[0] != "--background"))
                throw new Exception("Fuli.exe 只接受 --background。 / Fuli.exe accepts only --background.");
            if (!File.Exists(client))
                throw new Exception("没有找到 FULI 桌面客户端，请重新安装或更新 FULI。 / The FULI desktop client is missing; reinstall or update FULI.\n\n" + client);
            Process.Start(new ProcessStartInfo(client)
            {
                Arguments = args.Length == 1 ? "--background" : "",
                WorkingDirectory = Path.GetDirectoryName(client),
                UseShellExecute = false
            }).Dispose();
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "FULI", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
