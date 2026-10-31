using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

// Fuli.exe at the package root. Shortcuts, the launch-at-login entry, fuli://
// links and the one-click update (src/desktop/windows-desktop-client.js) open
// this file, also from older versions, so it stays at the root while the
// desktop client lives in client\ with its own DLLs and data folder. It only
// starts that client.
internal static class FuliLauncher
{
    // The client reads the link itself (desktop/flutter/lib/src/platform/fuli_link.dart)
    // and refuses longer ones too.
    private const int MaxLinkLength = 2048;

    [STAThread]
    private static int Main(string[] args)
    {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var client = Path.Combine(root, "client", "FULI.exe");
        try
        {
            // --background: started at login, the client shows only its tray icon.
            // fuli://…: a link the client follows (Windows passes it through HKCU\Software\Classes\fuli).
            if (args.Length > 1 || (args.Length == 1 && args[0] != "--background" && !IsLink(args[0])))
                throw new Exception("Fuli.exe 只接受 --background 或一个 fuli:// 链接。 / Fuli.exe accepts only --background or one fuli:// link.");
            if (!File.Exists(client))
                throw new Exception("没有找到 FULI 桌面客户端，请重新安装或更新 FULI。 / The FULI desktop client is missing; reinstall or update FULI.\n\n" + client);
            Process.Start(new ProcessStartInfo(client)
            {
                // A link holds no quote, backslash or space (IsLink), so quoting it keeps it one argument.
                Arguments = args.Length == 1 ? "\"" + args[0] + "\"" : "",
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

    // fuli:// followed by printable ASCII without spaces, quotes or backslashes.
    private static bool IsLink(string arg)
    {
        if (arg.Length > MaxLinkLength || !arg.StartsWith("fuli://", StringComparison.OrdinalIgnoreCase)) return false;
        foreach (var c in arg)
        {
            if (c <= ' ' || c > '~' || c == '"' || c == '\\') return false;
        }
        return true;
    }
}
