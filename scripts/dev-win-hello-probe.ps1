# Developer probe for Windows Hello (rec#7 D-28.10). Windows PowerShell 5.1 only.
#
# Not shipped and never used by FULI: `fuli app approve/rollback` asks Hello
# only through the CI-built fuli-win-helper.exe whose SHA-256 the package pins.
# This probe compiles a small interop type with Add-Type at run time, which is
# exactly what the shipped path must not do, so it runs only when
# FULI_DEV_WIN_PROBE=1. Its answer never approves anything.
#
#   $env:FULI_DEV_WIN_PROBE = '1'; powershell -File scripts/dev-win-hello-probe.ps1           # availability only
#   $env:FULI_DEV_WIN_PROBE = '1'; powershell -File scripts/dev-win-hello-probe.ps1 -Prompt   # opens the Hello dialog
param([switch]$Prompt, [string]$Message = 'FULI developer probe: no app is approved by this answer')

if ($env:FULI_DEV_WIN_PROBE -ne '1') {
  Write-Error 'Set FULI_DEV_WIN_PROBE=1 to run this developer probe; FULI itself never uses it.'
  exit 2
}
if ($PSVersionTable.PSEdition -ne 'Desktop') {
  Write-Error 'Run it with Windows PowerShell 5.1 (powershell.exe), which can load Windows Runtime types.'
  exit 2
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Wait-Operation($operation, [type]$resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $null = $task.Wait(-1)
  $task.Result
}

$availability = Wait-Operation ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) `
  ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
Write-Output "availability: $availability"
if (-not $Prompt -or "$availability" -ne 'Available') { exit 0 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IFuliUserConsentVerifierInterop
{
    [return: MarshalAs(UnmanagedType.IInspectable)]
    object RequestVerificationForWindowAsync(IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
}

public static class FuliHelloProbe
{
    // IAsyncOperation<UserConsentVerificationResult>
    private static readonly Guid AsyncOperationOfResult = new Guid("FD596FFD-2318-558F-9DBE-D21DF43764A5");

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    public static object Request(object factory, string message)
    {
        Guid iid = AsyncOperationOfResult;
        return ((IFuliUserConsentVerifierInterop)factory).RequestVerificationForWindowAsync(GetConsoleWindow(), message, ref iid);
    }
}
'@

$factory = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory(
  [Windows.Security.Credentials.UI.UserConsentVerifier])
$result = Wait-Operation ([FuliHelloProbe]::Request($factory, $Message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output "verification: $result"
