; Simplified Chinese for the messages FULI-Setup.exe shows. Inno Setup ships
; no Chinese translation; fuli-setup.iss loads this after Default.isl, so a
; message not listed here falls back to English.

[LangOptions]
LanguageName=简体中文
LanguageID=$0804
LanguageCodePage=0

[Messages]
SetupAppTitle=安装
SetupWindowTitle=安装 - %1
UninstallAppTitle=卸载
UninstallAppFullTitle=%1 卸载
ExitSetupTitle=退出安装
ExitSetupMessage=安装尚未完成。现在退出，FULI 不会被安装。%n%n以后可以再次运行本安装程序完成安装。%n%n退出安装？
ButtonBack=< 上一步(&B)
ButtonNext=下一步(&N) >
ButtonInstall=安装(&I)
ButtonOK=确定
ButtonCancel=取消
ButtonYes=是(&Y)
ButtonYesToAll=全是(&A)
ButtonNo=否(&N)
ButtonNoToAll=全否(&O)
ButtonFinish=完成(&F)
ButtonBrowse=浏览(&B)...
ButtonWizardBrowse=浏览(&R)...
ButtonNewFolder=新建文件夹(&M)
ClickNext=点击「下一步」继续，或点击「取消」退出安装。
WizardReady=准备安装
ReadyLabel1=安装程序已准备好在你的电脑上安装 [name]。
ReadyLabel2a=点击「安装」开始；无需管理员权限。
ReadyLabel2b=点击「安装」开始；无需管理员权限。
WizardPreparing=正在准备安装
PreparingDesc=安装程序正在准备在你的电脑上安装 [name]。
WizardInstalling=正在安装
InstallingLabel=正在安装 [name]，请稍候。
StatusExtractFiles=正在解压文件...
StatusCreateDirs=正在创建目录...
StatusSavingUninstall=正在保存卸载信息...
StatusRunProgram=正在完成安装...
StatusRollback=正在撤销更改...
FinishedHeadingLabel=[name] 已安装
FinishedLabelNoIcons=[name] 已安装到你的电脑上。
FinishedLabel=[name] 已安装到你的电脑上，可从桌面或开始菜单打开。
ClickFinish=点击「完成」退出安装。
RunEntryExec=运行 %1
ErrorTitle=错误
SetupAborted=安装没有完成。%n%n请解决问题后重新运行安装程序。
AbortRetryIgnoreSelectAction=选择操作
AbortRetryIgnoreRetry=重试(&T)
AbortRetryIgnoreIgnore=忽略错误并继续(&I)
AbortRetryIgnoreCancel=取消安装
