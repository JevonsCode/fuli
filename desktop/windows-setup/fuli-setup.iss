; FULI-Setup-<version>.exe: the one-file, double-click Windows install.
; Built by scripts/build-windows-setup.js from a verified tray directory
; (scripts/build-windows-tray.js), never by hand: it passes AppVersion (the
; tray's package.json version), TrayDir, OutputDir and OutputBaseFilename.
;
; The setup carries the tray directory, extracts it to a temporary folder and
; runs its bundled node with the existing per-user installer, hidden:
; src\desktop\windows-install.js --yes for a first install, or
; src\desktop\windows-update-command.js --yes when FULI is already installed
; (data is kept). It writes no program files and no uninstaller of its own;
; Uninstall-Fuli.cmd stays the uninstall, reached from Installed apps.
; Inno Setup 6.3 or later (ExecAndCaptureOutput).

#if Ver < EncodeVer(6, 3, 0)
  #error Inno Setup 6.3 or later is required
#endif
#ifndef AppVersion
  #error Build with scripts/build-windows-setup.js: AppVersion comes from the tray's package.json
#endif
#ifndef TrayDir
  #error Build with scripts/build-windows-setup.js: TrayDir is the verified tray directory
#endif

; Tray files this setup runs or points at; scripts/build-windows-setup.js
; refuses a tray without them.
#define TrayNode "runtime\node\node.exe"
#define TrayInstall "src\desktop\windows-install.js"
#define TrayUpdate "src\desktop\windows-update-command.js"
#define TrayUninstall "src\desktop\windows-uninstall-command.js"
#define TrayLauncher "Fuli.exe"
#define TrayNodeLauncher "FuliNode.exe"

[Setup]
AppId=FULI
AppName=FULI
AppVersion={#AppVersion}
AppVerName=FULI {#AppVersion}
AppPublisher=JevonsCode
AppPublisherURL=https://github.com/JevonsCode/fuli
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CreateAppDir=no
DisableWelcomePage=yes
DisableProgramGroupPage=yes
Uninstallable=no
CreateUninstallRegKey=no
SetupIconFile=..\..\brand\png\app-icon\fuli-app.ico
WizardStyle=modern
SetupLogging=yes
; The Windows display language picks Chinese or English; any other falls back to English.
ShowLanguageDialog=no
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zh"; MessagesFile: "compiler:Default.isl,ChineseSimplified.isl"

[CustomMessages]
zh.LaunchFuli=启动 FULI
en.LaunchFuli=Launch FULI
zh.Installing=正在安装 FULI 并核对每个文件…
en.Installing=Installing FULI and verifying every file...
zh.Updating=正在更新 FULI，数据保留不变…
en.Updating=Updating FULI; your data is kept...
zh.FailedHeading=FULI 没有装好
en.FailedHeading=FULI was not installed
zh.FailedLabel=安装步骤报告了下面的错误，FULI 的数据保留不变。%n%n%1%n%n完整记录：%2
en.FailedLabel=The install step reported the error below; FULI data is kept as it was.%n%n%1%n%nFull log: %2
zh.NotStarted=安装程序没能启动（错误 %1）。
en.NotStarted=The installer could not start (error %1).

[Files]
Source: "{#TrayDir}\*"; DestDir: "{tmp}\tray"; Flags: recursesubdirs createallsubdirs ignoreversion

[Run]
Filename: "{code:InstalledLauncher}"; Description: "{cm:LaunchFuli}"; Flags: postinstall nowait skipifsilent; Check: Succeeded

[Code]
const
  ErrorLines = 12;

var
  FailureText: String;

function InstallRoot: String;
begin
  Result := ExpandConstant('{localappdata}\Programs\Fuli');
end;

// One string field of installation.json. Only ASCII fields are read (version,
// installation id), so the file's UTF-8 needs no decoding here.
function RecordField(Name: String): String;
var
  Text: AnsiString;
  Rest: String;
  At: Integer;
begin
  Result := '';
  if not LoadStringFromFile(InstallRoot + '\installation.json', Text) then Exit;
  Rest := String(Text);
  At := Pos('"' + Name + '": "', Rest);
  if At = 0 then Exit;
  Delete(Rest, 1, At + Length(Name) + 4);
  At := Pos('"', Rest);
  if At > 0 then Result := Copy(Rest, 1, At - 1);
end;

function Installed: Boolean;
begin
  Result := FileExists(InstallRoot + '\installation.json');
end;

// The installed version's launcher: versions\<installation id>\Fuli.exe.
function InstalledLauncher(Param: String): String;
begin
  Result := InstallRoot + '\versions\' + RecordField('installationId') + '\{#TrayLauncher}';
end;

function Succeeded: Boolean;
begin
  Result := (FailureText = '') and FileExists(InstalledLauncher(''));
end;

function LastLines(Lines: TArrayOfString): String;
var
  I, First: Integer;
begin
  Result := '';
  First := GetArrayLength(Lines) - ErrorLines;
  if First < 0 then First := 0;
  for I := First to GetArrayLength(Lines) - 1 do
    if Trim(Lines[I]) <> '' then Result := Result + Trim(Lines[I]) + #13#10;
  Result := Trim(Result);
end;

// Runs one tray script with the tray's own node, without a console window.
// Its output goes to the setup log; an error becomes FailureText.
procedure RunTrayScript(Script: String; Arguments: String);
var
  Tray: String;
  Output: TExecOutput;
  Code, I: Integer;
begin
  Tray := ExpandConstant('{tmp}\tray');
  if not ExecAndCaptureOutput(Tray + '\{#TrayNode}', '"' + Tray + '\' + Script + '" ' + Arguments,
      Tray, SW_HIDE, ewWaitUntilTerminated, Code, Output) then begin
    FailureText := FmtMessage(CustomMessage('NotStarted'), [IntToStr(Code)]);
    Exit;
  end;
  for I := 0 to GetArrayLength(Output.StdOut) - 1 do Log('node: ' + Output.StdOut[I]);
  for I := 0 to GetArrayLength(Output.StdErr) - 1 do Log('node error: ' + Output.StdErr[I]);
  if Code <> 0 then begin
    FailureText := LastLines(Output.StdErr);
    if FailureText = '' then FailureText := LastLines(Output.StdOut);
    if FailureText = '' then FailureText := 'exit ' + IntToStr(Code);
  end;
end;

// FULI's entry in Installed apps. The version folder changes with every update,
// so it runs Uninstall-Fuli's script through the stable FuliNode.exe, which
// starts the version installation.json names; Uninstall-Fuli removes the entry.
procedure RegisterInstalledApp;
var
  Key, Launcher: String;
begin
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\FULI';
  Launcher := InstallRoot + '\{#TrayNodeLauncher}';
  if not FileExists(Launcher) then Exit;
  RegWriteStringValue(HKCU, Key, 'DisplayName', 'FULI');
  RegWriteStringValue(HKCU, Key, 'Publisher', 'JevonsCode');
  RegWriteStringValue(HKCU, Key, 'DisplayIcon', Launcher);
  RegWriteStringValue(HKCU, Key, 'InstallLocation', InstallRoot);
  RegWriteStringValue(HKCU, Key, 'UninstallString', '"' + ExpandConstant('{sys}\cmd.exe') + '" /d /c ""'
    + Launcher + '" {#TrayUninstall} || pause"');
  RegWriteDWordValue(HKCU, Key, 'NoModify', 1);
  RegWriteDWordValue(HKCU, Key, 'NoRepair', 1);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Update: Boolean;
begin
  if CurStep <> ssPostInstall then Exit;
  Update := Installed;
  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    if Update and (RecordField('applicationVersion') = '{#AppVersion}') then
      Log('FULI {#AppVersion} is already installed; nothing to change.')
    else if Update then begin
      WizardForm.StatusLabel.Caption := CustomMessage('Updating');
      RunTrayScript('{#TrayUpdate}', '--yes');
    end else begin
      WizardForm.StatusLabel.Caption := CustomMessage('Installing');
      // Data left by an earlier FULI (an uninstall keeps it) is bound unchanged;
      // the installer refuses a folder that is not FULI data.
      if DirExists(ExpandConstant('{localappdata}\Fuli')) then
        RunTrayScript('{#TrayInstall}', '--yes --adopt-existing-data')
      else
        RunTrayScript('{#TrayInstall}', '--yes');
    end;
  finally
    WizardForm.ProgressGauge.Style := npbstNormal;
    DelTree(ExpandConstant('{tmp}\tray'), True, True, True);
  end;
  if FailureText = '' then RegisterInstalledApp;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID <> wpFinished) or (FailureText = '') then Exit;
  WizardForm.FinishedHeadingLabel.Caption := CustomMessage('FailedHeading');
  WizardForm.FinishedLabel.Caption := FmtMessage(CustomMessage('FailedLabel'),
    [FailureText, ExpandConstant('{log}')]);
  WizardForm.FinishedLabel.AdjustHeight;
end;

function GetCustomSetupExitCode: Integer;
begin
  if FailureText <> '' then Result := 1 else Result := 0;
end;
