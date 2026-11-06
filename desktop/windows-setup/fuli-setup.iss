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
;
; Three pages, pictures before words (art\, drawn by
; scripts/build-installer-art.js at every DPI): the app icon with one
; 「安装」 button, the mark over the progress bar, and the icon with a check
; and one 「打开 FULI」 button. SmartScreen's note for the unsigned setup is
; a picture on the download page and in the README, not a page here.
; Inno Setup 6.6 or later (PNG wizard images and TBitmapImage.PngImage).

#if Ver < EncodeVer(6, 6, 0)
  #error Inno Setup 6.6 or later is required
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

; The page pictures' size in points at 100 % (build-installer-art.js SETUP_PICTURES).
#define PictureSize 120
#define MarkSize 80

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
DisableWelcomePage=no
DisableReadyPage=yes
DisableProgramGroupPage=yes
Uninstallable=no
CreateUninstallRegKey=no
SetupIconFile=..\..\brand\png\app-icon\fuli-app.ico
WizardStyle=modern
; Each DPI's own picture; Setup picks the one that fits.
WizardImageFile=art\panel-100.png,art\panel-125.png,art\panel-150.png,art\panel-175.png,art\panel-200.png,art\panel-225.png,art\panel-250.png
WizardSmallImageFile=art\small-100.png,art\small-125.png,art\small-150.png,art\small-175.png,art\small-200.png,art\small-225.png,art\small-250.png
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
zh.InstallTitle=安装 FULI
en.InstallTitle=Install FULI
zh.UpdateTitle=更新 FULI
en.UpdateTitle=Update FULI
zh.InstallButton=安装
en.InstallButton=Install
zh.UpdateButton=更新
en.UpdateButton=Update
zh.ReadyTitle=FULI 已就绪
en.ReadyTitle=FULI is ready
zh.OpenFuli=打开 FULI
en.OpenFuli=Open FULI
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
; The page pictures, extracted when a page shows them (PagePicture).
Source: "art\icon-*.png"; DestDir: "{tmp}"; Flags: dontcopy
Source: "art\done-*.png"; DestDir: "{tmp}"; Flags: dontcopy
Source: "art\mark-*.png"; DestDir: "{tmp}"; Flags: dontcopy

[Code]
const
  ErrorLines = 12;

var
  FailureText: String;
  WelcomePicture, MarkPicture, DonePicture: TBitmapImage;
  VersionLabel: TNewStaticText;

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

// The drawn scale for this DPI: the smallest one at least as large.
function PictureScale: Integer;
var
  Wanted: Integer;
begin
  Wanted := ScaleX(100);
  if Wanted <= 100 then Result := 100
  else if Wanted <= 125 then Result := 125
  else if Wanted <= 150 then Result := 150
  else if Wanted <= 175 then Result := 175
  else if Wanted <= 200 then Result := 200
  else if Wanted <= 225 then Result := 225
  else Result := 250;
end;

// art\<Name>-<scale>.png on Parent, Points square, centred on CentreX.
function PagePicture(Parent: TWinControl; Name: String; Points, CentreX, Top: Integer): TBitmapImage;
var
  FileName: String;
begin
  FileName := Name + '-' + IntToStr(PictureScale) + '.png';
  ExtractTemporaryFile(FileName);
  Result := TBitmapImage.Create(WizardForm);
  Result.Parent := Parent;
  // The pages are window-coloured; the pictures' transparent edges blend into it.
  Result.BackColor := clWindow;
  Result.Stretch := True;
  Result.Width := ScaleX(Points);
  Result.Height := ScaleX(Points);
  Result.Left := CentreX - Result.Width div 2;
  Result.Top := Top;
  Result.PngImage.LoadFromFile(ExpandConstant('{tmp}\') + FileName);
end;

procedure CentreBelow(Text: TNewStaticText; Picture: TBitmapImage; Gap: Integer);
begin
  Text.Alignment := taCenter;
  Text.Top := Picture.Top + Picture.Height + ScaleY(Gap);
  Text.AdjustHeight;
end;

procedure InitializeWizard;
var
  Centre, Shift: Integer;
begin
  // First page: the app icon, 「安装 FULI」 (or 「更新 FULI」), the version.
  Centre := WizardForm.WelcomeLabel1.Left + WizardForm.WelcomeLabel1.Width div 2;
  WelcomePicture := PagePicture(WizardForm.WelcomePage, 'icon', {#PictureSize}, Centre, ScaleY(64));
  if Installed then
    WizardForm.WelcomeLabel1.Caption := CustomMessage('UpdateTitle')
  else
    WizardForm.WelcomeLabel1.Caption := CustomMessage('InstallTitle');
  CentreBelow(WizardForm.WelcomeLabel1, WelcomePicture, 20);
  WizardForm.WelcomeLabel2.Visible := False;
  VersionLabel := TNewStaticText.Create(WizardForm);
  VersionLabel.Parent := WizardForm.WelcomePage;
  VersionLabel.Caption := 'v{#AppVersion}';
  VersionLabel.Font.Color := clGrayText;
  VersionLabel.Top := WizardForm.WelcomeLabel1.Top + WizardForm.WelcomeLabel1.Height + ScaleY(8);
  VersionLabel.Left := Centre - VersionLabel.Width div 2;

  // Progress: no header (it would repeat the status line), the mark, one
  // centred status line and the bar. The page takes the header's room.
  Shift := WizardForm.InnerNotebook.Top - WizardForm.MainPanel.Top;
  WizardForm.MainPanel.Visible := False;
  WizardForm.Bevel1.Visible := False;
  WizardForm.InnerNotebook.Top := WizardForm.InnerNotebook.Top - Shift;
  WizardForm.InnerNotebook.Height := WizardForm.InnerNotebook.Height + Shift;
  WizardForm.FilenameLabel.Visible := False;
  Centre := WizardForm.ProgressGauge.Left + WizardForm.ProgressGauge.Width div 2;
  MarkPicture := PagePicture(WizardForm.InstallingPage, 'mark', {#MarkSize}, Centre, ScaleY(64));
  WizardForm.StatusLabel.Alignment := taCenter;
  WizardForm.StatusLabel.Top := MarkPicture.Top + MarkPicture.Height + ScaleY(24);
  WizardForm.ProgressGauge.Top := WizardForm.StatusLabel.Top + WizardForm.StatusLabel.Height + ScaleY(12);

  // Last page: the icon with a check, 「FULI 已就绪」, and 「打开 FULI」.
  Centre := WizardForm.FinishedHeadingLabel.Left + WizardForm.FinishedHeadingLabel.Width div 2;
  DonePicture := PagePicture(WizardForm.FinishedPage, 'done', {#PictureSize}, Centre, ScaleY(64));
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Widen: Integer;
begin
  if CurPageID = wpWelcome then begin
    if Installed then
      WizardForm.NextButton.Caption := CustomMessage('UpdateButton')
    else
      WizardForm.NextButton.Caption := CustomMessage('InstallButton');
  end;
  if CurPageID <> wpFinished then Exit;
  if FailureText = '' then begin
    WizardForm.FinishedHeadingLabel.Caption := CustomMessage('ReadyTitle');
    CentreBelow(WizardForm.FinishedHeadingLabel, DonePicture, 20);
    WizardForm.FinishedLabel.Visible := False;
    if Succeeded then begin
      Widen := ScaleX(40);
      WizardForm.NextButton.Width := WizardForm.NextButton.Width + Widen;
      WizardForm.NextButton.Left := WizardForm.NextButton.Left - Widen;
      WizardForm.NextButton.Caption := CustomMessage('OpenFuli');
    end;
    Exit;
  end;
  DonePicture.Visible := False;
  WizardForm.FinishedHeadingLabel.Caption := CustomMessage('FailedHeading');
  // A [Code] line must not start with "[" or Inno Setup reads it as a section tag.
  WizardForm.FinishedLabel.Caption := FmtMessage(CustomMessage('FailedLabel'), [FailureText, ExpandConstant('{log}')]);
  WizardForm.FinishedLabel.AdjustHeight;
end;

// 「打开 FULI」 on the last page starts the installed version, then Setup closes.
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if (CurPageID = wpFinished) and (not WizardSilent) and Succeeded then
    ShellExec('', InstalledLauncher(''), '', '', SW_SHOWNORMAL, ewNoWait, Code);
end;

function GetCustomSetupExitCode: Integer;
begin
  if FailureText <> '' then Result := 1 else Result := 0;
end;
