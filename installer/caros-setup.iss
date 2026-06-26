; Caros Windows installer — lets the user choose the Desktop app and/or the CLI.
;
; Build (signs the resulting Setup.exe with the AECOM cert):
;   & "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" `
;     "/Ssigntool=`"C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe`" sign /sha1 3B069415B5234C8F2CCF981396FC97AB37CFAE0C /tr http://timestamp.digicert.com /td sha256 /fd sha256 `$f" `
;     installer\caros-setup.iss
;
; Inputs (produced by `pnpm run make` + signing):
;   ..\ui\desktop\out\Caros-win32-x64\   (packaged, signed desktop app)
;   ..\ui\desktop\out\release\caros.exe  (signed CLI)
; Output:
;   ..\ui\desktop\out\release\Caros-Setup.exe

#define AppName "Caros"
#define AppVer "0.1.0"
#define AppPublisher "AECOM Singapore Pte. Ltd."
#define DeskSrc "..\ui\desktop\out\Caros-win32-x64"
#define CliExe  "..\ui\desktop\out\release\caros.exe"
#define IconFile "..\ui\desktop\src\images\icon.ico"

[Setup]
AppId={{B2C9A4E1-CA12-4A1C-9B7E-0CA705E70001}
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Caros
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\ui\desktop\out\release
OutputBaseFilename=Caros-Setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Desktop\Caros.exe
UninstallDisplayName={#AppName}
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
SignTool=signtool

[Types]
Name: "full";    Description: "Desktop app and CLI"
Name: "desktop"; Description: "Desktop app only"
Name: "cli";     Description: "CLI only"
Name: "custom";  Description: "Custom"; Flags: iscustom

[Components]
Name: "desktop"; Description: "Caros Desktop app";     Types: full desktop custom
Name: "cli";     Description: "Caros CLI (caros.exe)";  Types: full cli custom

[Files]
; Desktop app (Caros.exe + resources). Goes under {app}\Desktop so the CLI's
; lowercase caros.exe can't collide with the desktop's Caros.exe.
Source: "{#DeskSrc}\*"; DestDir: "{app}\Desktop"; Flags: recursesubdirs createallsubdirs ignoreversion; Components: desktop
; CLI
Source: "{#CliExe}"; DestDir: "{app}\cli"; DestName: "caros.exe"; Flags: ignoreversion; Components: cli

[Icons]
Name: "{autoprograms}\Caros"; Filename: "{app}\Desktop\Caros.exe"; Components: desktop
Name: "{autodesktop}\Caros";  Filename: "{app}\Desktop\Caros.exe"; Components: desktop; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Components: desktop
Name: "addtopath";   Description: "Add the Caros CLI to my PATH"; Components: cli

[Run]
Filename: "{app}\Desktop\Caros.exe"; Description: "Launch Caros"; Flags: nowait postinstall skipifsilent; Components: desktop

[Code]
const EnvKey = 'Environment';

function CliDir(): string;
begin
  Result := ExpandConstant('{app}\cli');
end;

procedure AddCliToPath();
var Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then Paths := '';
  if Pos(';' + Lowercase(CliDir()) + ';', ';' + Lowercase(Paths) + ';') > 0 then exit;
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + CliDir());
end;

procedure RemoveCliFromPath();
var Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then exit;
  if Pos(Lowercase(CliDir()), Lowercase(Paths)) = 0 then exit;
  StringChangeEx(Paths, ';' + CliDir(), '', True);
  StringChangeEx(Paths, CliDir() + ';', '', True);
  StringChangeEx(Paths, CliDir(), '', True);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths);
end;

procedure CurStepChanged(s: TSetupStep);
begin
  if (s = ssPostInstall) and IsComponentSelected('cli') and IsTaskSelected('addtopath') then
    AddCliToPath();
end;

procedure CurUninstallStepChanged(s: TUninstallStep);
begin
  if s = usPostUninstall then RemoveCliFromPath();
end;
