; Optional Inno Setup script for building a native Windows installer (.exe).
; Compile with: iscc packaging\windows\fuli-installer.iss

#define MyAppName "FULI"
#define MyAppVersion "1.0.0-next.0"
#define MyAppPublisher "FULI"
#define MyAppExeName "fuli-context.exe"

[Setup]
AppId={{8F54A3F1-6A9C-4E12-A2B8-7D4C52E10A91}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\FULI
DefaultGroupName=FULI
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist-next
OutputBaseFilename=FULI-{#MyAppVersion}-windows-x64-setup
SetupIconFile=..\..\brand\png\app-icon\fuli-app.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "..\..\target\release\fuli-context.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\target\release\fuli.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\target\release\fuli-ui.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\brand\png\app-icon\fuli-app.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\FULI"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\fuli-app.ico"
Name: "{autodesktop}\FULI"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\fuli-app.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"
Name: "startup"; Description: "Launch FULI low-memory tray daemon on Windows sign-in"; GroupDescription: "Startup:"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "FULI"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch FULI now"; Flags: nowait postinstall skipifsilent
