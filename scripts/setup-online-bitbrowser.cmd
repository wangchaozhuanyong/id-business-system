@echo off
chcp 65001 >nul
setlocal
set "IDB_SETUP_PROJECT=%~dp0.."
set "IDB_SETUP_ENTRY=%IDB_SETUP_PROJECT%\apps\api\src\id-business-v2\online-recharge\connector\setup_background.py"
if exist "%IDB_SETUP_PROJECT%\.runtime\bitbrowser-recharge-assistant\venv\Scripts\python.exe" (
  "%IDB_SETUP_PROJECT%\.runtime\bitbrowser-recharge-assistant\venv\Scripts\python.exe" "%IDB_SETUP_ENTRY%" --interactive --apply
) else (
  py -3 "%IDB_SETUP_ENTRY%" --interactive --apply
)
if errorlevel 1 (
  echo 设置未完成，请查看上方提示。原任务与凭据不会被删除。
) else (
  echo 后台启动已配置。以后登录电脑后自动运行，日常只需操作网站；请回网站刷新电脑状态。
)
pause
