using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Windows.Security.Credentials.UI;

namespace Fuli.WinHelper;

// fuli-win-helper: the Windows parts FULI cannot do from Node (rec#7 D-28.10).
//
// `hello` reads one JSON request on stdin ({"protocol":1,"challengeId","message"}),
// asks Windows Hello (IUserConsentVerifierInterop) for the console window, or for
// a hidden window when the process has no console, and writes one JSON line with
// the Windows availability or verification result for that challenge. It does
// not sign the challenge: Hello returns only whether the current user verified.
// Any other outcome (bad input, an exception) exits non-zero with no answer line.
internal static partial class Program
{
    private const int Protocol = 1;
    private const int MaxRequestBytes = 16 * 1024;
    private const int MaxMessageLength = 1024;

    private static async Task<int> Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "hello")
        {
            Console.Error.WriteLine("usage: fuli-win-helper hello < request.json");
            return 2;
        }
        var request = ReadRequest();
        if (request is null)
        {
            Console.Error.WriteLine("invalid request");
            return 2;
        }
        var availability = await UserConsentVerifier.CheckAvailabilityAsync();
        if (availability != UserConsentVerifierAvailability.Available)
        {
            Answer(request.Value.ChallengeId, "availability", availability.ToString());
            return 0;
        }
        using var owner = OwnerWindow.Open();
        var result = await UserConsentVerifierInterop.RequestVerificationForWindowAsync(owner.Handle, request.Value.Message);
        Answer(request.Value.ChallengeId, "verification", result.ToString());
        return 0;
    }

    private readonly record struct Request(string ChallengeId, string Message);

    private static Request? ReadRequest()
    {
        try
        {
            using var input = Console.OpenStandardInput();
            var buffer = new MemoryStream();
            var chunk = new byte[4096];
            int read;
            while ((read = input.Read(chunk, 0, chunk.Length)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > MaxRequestBytes) return null;
            }
            using var document = JsonDocument.Parse(buffer.ToArray());
            var root = document.RootElement;
            if (root.GetProperty("protocol").GetInt32() != Protocol) return null;
            var challengeId = root.GetProperty("challengeId").GetString();
            var message = root.GetProperty("message").GetString();
            if (challengeId is null || !ChallengeIdPattern().IsMatch(challengeId)) return null;
            if (string.IsNullOrWhiteSpace(message) || message.Length > MaxMessageLength) return null;
            return new Request(challengeId, message);
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException
            or KeyNotFoundException or FormatException or IOException)
        {
            return null;
        }
    }

    private static void Answer(string challengeId, string stage, string result)
    {
        using var output = Console.OpenStandardOutput();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteNumber("protocol", Protocol);
            writer.WriteString("command", "hello");
            writer.WriteString("challengeId", challengeId);
            writer.WriteString("stage", stage);
            writer.WriteString("result", result);
            writer.WriteEndObject();
        }
        output.WriteByte((byte)'\n');
    }

    [GeneratedRegex("^apc-[0-9a-f]{32}$")]
    private static partial Regex ChallengeIdPattern();
}

// The window Hello's dialog belongs to: the console FULI runs in, or a hidden
// top-level window this process creates and destroys when it has no console.
internal sealed partial class OwnerWindow : IDisposable
{
    public IntPtr Handle { get; }
    private readonly bool _created;

    private OwnerWindow(IntPtr handle, bool created)
    {
        Handle = handle;
        _created = created;
    }

    public static OwnerWindow Open()
    {
        var console = GetConsoleWindow();
        if (console != IntPtr.Zero) return new OwnerWindow(console, created: false);
        var hidden = CreateWindowExW(0, "Static", "FULI", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (hidden == IntPtr.Zero) throw new InvalidOperationException("no window for the Hello dialog");
        return new OwnerWindow(hidden, created: true);
    }

    public void Dispose()
    {
        if (_created) DestroyWindow(Handle);
    }

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GetConsoleWindow();

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    private static partial IntPtr CreateWindowExW(int exStyle, string className, string windowName, int style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DestroyWindow(IntPtr window);
}
